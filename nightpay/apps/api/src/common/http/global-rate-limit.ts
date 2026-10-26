import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { bearerToken, verifyStaffToken } from '../guards/staff-token';
import { clientIp, normalizeIp, type ClientIpRequest } from './client-ip';

/**
 * Límite global de peticiones (@fastify/rate-limit, main.ts), por minuto y
 * en cada réplica del API. Todo un local sale a internet por la misma IP (el
 * wifi), personal y clientes: contar solo por IP daba 429 a todo el local en
 * hora punta. Ahora:
 *  - con la sesión del personal válida (firma y hora; Bearer): por persona,
 *    sus móviles y pestañas juntos; y todas las de un local, con un tope;
 *  - sin ella (clientes, datáfonos, el sondeo sin sesión): por IP de fiar
 *    (CF-Connecting-IP solo si de verdad viene de Cloudflare, client-ip.ts).
 * Un token inventado, caducado o de un solo uso cuenta como anónimo: no da
 * cupo propio. Lo sensible (login, PIN, códigos) tiene además su @IpRateLimit.
 */
export const GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
export const GLOBAL_LIMITS = Object.freeze({
  /** Sin sesión, por IP: las páginas y acciones de los clientes del local. */
  ip: 300,
  /** Por persona del personal (la app de la chica sondea cada pocos segundos). */
  user: 600,
  /** Todas las personas de un local juntas. */
  venue: 6_000,
});
export type GlobalLimits = { readonly [K in keyof typeof GLOBAL_LIMITS]: number };
export type GlobalLimitKind = 'ip' | 'user' | 'venue';

const HEALTH_PATHS = ['/v1/health', '/v1/health/live'];
/** La página del saldo consulta su estado cada pocos segundos: va con su propio @IpRateLimit. */
const WALLET_STATE_POLL = /^\/w\/[^/]+\/state(\?|$)/;
/**
 * Las páginas de /pay (pago, «Comprobando» que se refresca cada 3-5 s, vuelta
 * del banco, formulario y justificante): con el wifi del local muchos clientes
 * comparten IP y el límite global les cortaba el pago con un JSON. Van con su
 * @IpRateLimit holgado y, si se pasa, una página que espera (PayPageFilter).
 */
const PAY_PAGES = /^\/pay\/[^/?]+(\/(checkout|receipt))?(\?|$)/;
/**
 * El estado de un cobro por su QR: lo sondean sin sesión la página del
 * cliente y las apps del personal (cada 4 s sin tiempo real, por cada cobro
 * abierto y desde la misma IP). Va con su propio @IpRateLimit.
 */
const PAYMENT_PUBLIC_POLL = /^\/v1\/payments\/public\/[^/?]+(\?|$)/;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

interface LimitedRequest extends ClientIpRequest {
  method: string;
  url: string;
}

/**
 * Fuera del límite global: los sondeos con su propio límite (saldo, estado
 * del cobro), las páginas GET de /pay y el healthcheck del propio contenedor.
 * Antes, todo lo que llegaba por loopback quedaba exento: con un proxy en la
 * misma máquina (p. ej. un túnel de Cloudflare) no habría límite.
 */
export function isGlobalRateLimitExempt(req: LimitedRequest): boolean {
  if (req.method === 'GET' && [WALLET_STATE_POLL, PAY_PAGES, PAYMENT_PUBLIC_POLL].some((re) => re.test(req.url))) {
    return true;
  }
  const peer = normalizeIp(req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress);
  const path = req.url.split('?')[0] ?? req.url;
  return peer !== null && LOOPBACK.has(peer) && HEALTH_PATHS.includes(path);
}

/** Sin sesión: la misma IP de fiar que el login y los @IpRateLimit (ver client-ip.ts). */
export function anonymousRateLimitKey(req: LimitedRequest): string {
  return `ip:${clientIp(req) ?? 'desconocida'}`;
}

type Identity = { kind: 'user'; tenantId: string; venueFull: boolean } | { kind: 'ip' };

export interface GlobalRateLimitDeps {
  /** El de las sesiones (JWT_SECRET): sin firma buena, la petición es anónima. */
  jwtSecret: string;
  limits?: Partial<GlobalLimits>;
  now?: () => number;
  /** Cada 429 del límite global, por tope (para la métrica). */
  onLimited?: (kind: GlobalLimitKind) => void;
}

/** Ventana fija por local: cuántas peticiones lleva en este minuto. */
class VenueWindows {
  private readonly windows = new Map<string, { window: number; count: number }>();

  hit(tenantId: string, window: number): number {
    const current = this.windows.get(tenantId);
    const count = current?.window === window ? current.count + 1 : 1;
    this.windows.set(tenantId, { window, count });
    return count;
  }
}

/** Clave del cliente de Node: la misma petición en keyGenerator, max y onExceeded. */
function requestKey(req: object): object {
  const raw = (req as { raw?: unknown }).raw;
  return typeof raw === 'object' && raw !== null ? raw : req;
}

export function createGlobalRateLimit(deps: GlobalRateLimitDeps) {
  const limits: GlobalLimits = { ...GLOBAL_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const jwt = new JwtService({ secret: deps.jwtSecret });
  const venues = new VenueWindows();
  const identities = new WeakMap<object, Identity>();

  const identify = async (req: LimitedRequest): Promise<{ key: string; identity: Identity }> => {
    const token = bearerToken(req.headers['authorization']);
    const verified = token ? await verifyStaffToken(jwt, token) : null;
    if (!verified?.ok) return { key: anonymousRateLimitKey(req), identity: { kind: 'ip' } };
    return {
      key: `user:${verified.payload.sub}`,
      identity: { kind: 'user', tenantId: verified.payload.tenantId, venueFull: false },
    };
  };

  return {
    allowList: (req: LimitedRequest): boolean => isGlobalRateLimitExempt(req),
    keyGenerator: async (req: LimitedRequest): Promise<string> => {
      const { key, identity } = await identify(req);
      identities.set(requestKey(req), identity);
      return key;
    },
    /** Tope de esta petición. Con el local lleno, 0: el plugin responde 429 como con cualquier tope. */
    max: (req: LimitedRequest, _key: string): number => {
      const identity = identities.get(requestKey(req));
      if (identity?.kind !== 'user') return limits.ip;
      const count = venues.hit(identity.tenantId, Math.floor(now() / GLOBAL_RATE_LIMIT_WINDOW_MS));
      identity.venueFull = count > limits.venue;
      return identity.venueFull ? 0 : limits.user;
    },
    onExceeded: (req: LimitedRequest, key: string): void => {
      const identity = identities.get(requestKey(req));
      const kind: GlobalLimitKind = identity?.kind === 'user' ? (identity.venueFull ? 'venue' : 'user') : 'ip';
      deps.onLimited?.(kind);
      logExceeded(kind, kind === 'venue' && identity?.kind === 'user' ? `local:${identity.tenantId}` : key, now());
    },
  };
}

const logger = new Logger('GlobalRateLimit');
/** Un aviso por clave y minuto (la métrica las cuenta todas). */
const lastLogged = new Map<string, number>();
const MAX_LOGGED_KEYS = 10_000;

function logExceeded(kind: GlobalLimitKind, key: string, at: number): void {
  const window = Math.floor(at / GLOBAL_RATE_LIMIT_WINDOW_MS);
  if (lastLogged.get(key) === window) return;
  if (lastLogged.size >= MAX_LOGGED_KEYS) lastLogged.clear();
  lastLogged.set(key, window);
  logger.warn(`Límite global (${kind}) superado: ${key}`);
}

interface MetricsLike {
  rateLimited: { inc(labels: { limiter: string; kind: string }): void };
}

/** Las opciones de @fastify/rate-limit para main.ts. */
export function globalRateLimitOptions(jwtSecret: string, metrics?: MetricsLike): RateLimitPluginOptions {
  const rl = createGlobalRateLimit({
    jwtSecret,
    onLimited: (kind) => metrics?.rateLimited.inc({ limiter: 'global', kind }),
  });
  return {
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW_MS,
    max: rl.max,
    keyGenerator: rl.keyGenerator,
    allowList: rl.allowList,
    onExceeded: rl.onExceeded,
  };
}
