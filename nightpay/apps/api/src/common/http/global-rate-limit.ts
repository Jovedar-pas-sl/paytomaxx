import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { bearerToken, verifyStaffToken } from '../guards/staff-token';
import { clientIp, normalizeIp, rateLimitIpKey, type ClientIpRequest } from './client-ip';

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
 *
 * Al local solo suma lo que cabe en el tope de cada persona: un móvil en bucle
 * (o el token de alguien dado de baja, que aquí solo se mira la firma) se
 * queda en su 429 sin dejar al resto del local sin cupo. Y un token que este
 * nodo ya sabe revocado (AccessRevocationService.isKnownRevoked, sin ir a
 * Redis) no suma al local nada.
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

/** Sin sesión: la misma IP de fiar que el login y los @IpRateLimit (en IPv6, su /64; ver client-ip.ts). */
export function anonymousRateLimitKey(req: LimitedRequest): string {
  const ip = clientIp(req);
  return `ip:${ip ? rateLimitIpKey(ip) : 'desconocida'}`;
}

type Identity =
  | { kind: 'user'; userId: string; tenantId: string; revoked: boolean; venueFull: boolean }
  | { kind: 'ip' };

/** Lo del token que hace falta para saber si su sesión se cerró. */
export interface RateLimitTokenRef {
  sub: string;
  sid?: string;
  iat?: number;
}

export interface GlobalRateLimitDeps {
  /** El de las sesiones (JWT_SECRET): sin firma buena, la petición es anónima. */
  jwtSecret: string;
  limits?: Partial<GlobalLimits>;
  now?: () => number;
  /** Cada 429 del límite global, por tope (para la métrica). */
  onLimited?: (kind: GlobalLimitKind) => void;
  /** ¿Sabe ya este nodo que la sesión de este token se cerró? Síncrono: sin Redis. */
  isKnownRevoked?: (token: RateLimitTokenRef) => boolean;
}

/**
 * Ventana fija (de un minuto) por clave: cuántas peticiones lleva. Al cambiar
 * de minuto se olvidan las claves del anterior (no crece sin fin).
 */
class FixedWindows {
  private readonly windows = new Map<string, number>();
  private window = Number.NaN;

  hit(key: string, window: number): number {
    if (window !== this.window) {
      this.windows.clear();
      this.window = window;
    }
    const count = (this.windows.get(key) ?? 0) + 1;
    this.windows.set(key, count);
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
  const venues = new FixedWindows();
  const users = new FixedWindows();
  const identities = new WeakMap<object, Identity>();

  const identify = async (req: LimitedRequest): Promise<{ key: string; identity: Identity }> => {
    const token = bearerToken(req.headers['authorization']);
    const verified = token ? await verifyStaffToken(jwt, token) : null;
    if (!verified?.ok) return { key: anonymousRateLimitKey(req), identity: { kind: 'ip' } };
    const { sub, tenantId } = verified.payload;
    const revoked = deps.isKnownRevoked?.(verified.payload) ?? false;
    return { key: `user:${sub}`, identity: { kind: 'user', userId: sub, tenantId, revoked, venueFull: false } };
  };

  return {
    allowList: (req: LimitedRequest): boolean => isGlobalRateLimitExempt(req),
    keyGenerator: async (req: LimitedRequest): Promise<string> => {
      const { key, identity } = await identify(req);
      identities.set(requestKey(req), identity);
      return key;
    },
    /**
     * Tope de esta petición. Con el local lleno, 0: el plugin responde 429
     * como con cualquier tope. Al local solo suma lo que cabe en el tope de
     * la persona (lo de más ya es su 429) y nada de un token revocado.
     */
    max: (req: LimitedRequest, _key: string): number => {
      const identity = identities.get(requestKey(req));
      if (identity?.kind !== 'user') return limits.ip;
      const window = Math.floor(now() / GLOBAL_RATE_LIMIT_WINDOW_MS);
      const withinUser = users.hit(identity.userId, window) <= limits.user;
      if (!withinUser || identity.revoked) return limits.user;
      identity.venueFull = venues.hit(identity.tenantId, window) > limits.venue;
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
export function globalRateLimitOptions(
  jwtSecret: string,
  metrics?: MetricsLike,
  isKnownRevoked?: (token: RateLimitTokenRef) => boolean,
): RateLimitPluginOptions {
  const rl = createGlobalRateLimit({
    jwtSecret,
    onLimited: (kind) => metrics?.rateLimited.inc({ limiter: 'global', kind }),
    ...(isKnownRevoked ? { isKnownRevoked } : {}),
  });
  return {
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW_MS,
    max: rl.max,
    keyGenerator: rl.keyGenerator,
    allowList: rl.allowList,
    onExceeded: rl.onExceeded,
  };
}
