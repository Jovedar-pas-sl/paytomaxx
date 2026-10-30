import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { clientIp, rateLimitIpKey, type ClientIpRequest } from '../http/client-ip';
import { resolveLanguage, type PayLanguage } from '../../modules/payments/customer-lang';
import { CUSTOMER_TEXT } from '../../modules/payments/i18n';

/**
 * La IP real (de fiar) del cliente: ver common/http/client-ip.ts. Se
 * re-exporta aquí porque el login y otros módulos la importan de este archivo.
 */
export { clientIp };

/** Clave del metadato que pone @IpRateLimit (exportada para las pruebas de las rutas). */
export const IP_RATE_LIMIT_META = 'np:ip-rate-limit';
const META_KEY = IP_RATE_LIMIT_META;
/** Con `failOpen`, lo más que se espera a Redis antes de dejar pasar. */
export const IP_LIMIT_FAIL_OPEN_TIMEOUT_MS = 500;
/** Un aviso por scope y minuto mientras Redis no conteste. */
const FAIL_OPEN_LOG_EVERY_MS = 60_000;

export interface IpRateLimitConfig {
  /** Tope de requests permitidos en la ventana. */
  max: number;
  /** Tamaño de la ventana en segundos. */
  windowSec: number;
  /** Tag corto para identificar el bucket Redis (p.ej. 'auth-login'). */
  scope: string;
  /**
   * Además, un cupo por IP + cuenta (el campo `field` del cuerpo, p. ej. el
   * email del login), más bajo que el de la IP: todo el personal de un local
   * sale por la misma IP, y así cada cuenta tiene el suyo y la IP un tope más
   * alto. Sin el campo en el cuerpo cuenta solo la IP.
   */
  perAccount?: { field: string; max: number };
  /**
   * Además, un cupo por IP + recurso: el valor de la query (`query`, p. ej. el
   * `op` de /pay/result/status) o de la ruta (`param`, p. ej. el `:token` de
   * /pay/:token/status). Los clientes del wifi del local consultan cada uno su
   * cobro: cada cobro tiene su cupo desde esa IP y la IP un tope más alto (que
   * corta a quien recorre tokens). El valor se guarda como huella: es un secreto.
   */
  perKey?: { query?: string; param?: string; max: number };
  /**
   * Si Redis no responde, dejar pasar (con aviso en el log) en vez de
   * fallar. Solo para las páginas y sondeos de LECTURA del cliente (pago,
   * estado del cobro, saldo): sin Redis daban 500 al cliente en pleno pago.
   * Lo que adivina un secreto (login, PIN, llaves, códigos) no lo lleva:
   * sigue cerrado. El AuthGuard del personal tampoco cambia (503).
   */
  failOpen?: boolean;
}

/** Lo que dura el email más largo (RFC 5321): lo que se cuenta de la cuenta. */
const MAX_ACCOUNT_CHARS = 254;

/**
 * Decorator para aplicar un rate-limit por IP MUY estricto a un handler.
 * Pensado para endpoints sensibles (login, refresh, accept-invite, password-reset)
 * donde el global (300/min por IP sin sesión) es demasiado laxo y el atacante
 * puede enumerar.
 *
 * @example
 *   @Post('login')
 *   @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-login' })
 *   async login(...) { ... }
 */
export const IpRateLimit = (config: IpRateLimitConfig) =>
  SetMetadata(META_KEY, config);

type MinimalReq = ClientIpRequest & {
  query?: { lang?: unknown } & Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: ({ lang?: unknown } & Record<string, unknown>) | null;
  headers?: Record<string, string | string[] | undefined>;
};

/** `code` estable del 429 (las páginas del cliente lo traducen; ver wallets/client-errors.ts). */
export const RATE_LIMITED_CODE = 'RATE_LIMITED';

/** El 429 en el idioma de la página que llama (?lang=, el `lang` del cuerpo o su cookie; si no, español). */
export const RATE_LIMITED_MESSAGES: Readonly<Record<PayLanguage, string>> = {
  es: CUSTOMER_TEXT.es.errors.RATE_LIMITED,
  en: CUSTOMER_TEXT.en.errors.RATE_LIMITED,
  fr: CUSTOMER_TEXT.fr.errors.RATE_LIMITED,
  pt: CUSTOMER_TEXT.pt.errors.RATE_LIMITED,
};

function requestLanguage(req: MinimalReq): PayLanguage {
  return resolveLanguage(req.query?.lang ?? req.body?.lang, req.headers?.cookie);
}

/**
 * Guard que lee el meta del handler y aplica fixed-window INCR en Redis.
 *
 * Clave Redis: nightpay:iprl:<scope>:<ip>:<windowBucket> (en IPv6, su red
 * /64: rateLimitIpKey). Si count > max al final del bucket → 429 Too Many
 * Requests + Retry-After. El log lleva la IP entera.
 *
 * Importante: este guard es GLOBAL pero solo actúa cuando el meta está set;
 * sin meta es no-op, evitando overhead en endpoints normales.
 */
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(IpRateLimitGuard.name);
  private readonly reflector: Reflector;
  private readonly redis: Redis;
  private readonly failOpenLoggedAt = new Map<string, number>();

  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.reflector = reflector;
    this.redis = redis;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<IpRateLimitConfig | undefined>(
      META_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!config) return true;

    const req = ctx.switchToHttp().getRequest<MinimalReq>();
    const ip = clientIp(req);
    if (!ip) return true; // sin IP confiable no rate-limitamos (raro pero defensivo)

    // Fixed window: bucket = floor(now / windowSec). Reset implícito al cambiar bucket.
    const bucket = Math.floor(Date.now() / 1000 / config.windowSec);
    const net = rateLimitIpKey(ip);
    const account = config.perAccount ? accountOf(req.body, config.perAccount.field) : null;
    const resource = config.perKey ? resourceOf(req, config.perKey) : null;
    const checks: Array<{ key: string; max: number; what: string }> = [
      { key: `nightpay:iprl:${config.scope}:${net}:${bucket}`, max: config.max, what: 'ip' },
      ...(config.perAccount && account
        ? [{ key: `nightpay:iprl:${config.scope}:acct:${net}:${account}:${bucket}`, max: config.perAccount.max, what: 'ip+cuenta' }]
        : []),
      ...(config.perKey && resource
        ? [{ key: `nightpay:iprl:${config.scope}:res:${net}:${resource}:${bucket}`, max: config.perKey.max, what: 'ip+recurso' }]
        : []),
    ];
    for (const check of checks) {
      const count = await this.count(check.key, config);
      if (count === null) return true;
      if (count > check.max) await this.reject(ctx, req, config, check, ip, count);
    }
    return true;
  }

  /** La cuenta en Redis; con `failOpen` y Redis sin responder, null (= dejar pasar). */
  private async count(key: string, config: IpRateLimitConfig): Promise<number | null> {
    if (!config.failOpen) return this.hit(key, config.windowSec);
    try {
      return await withTimeout(this.hit(key, config.windowSec), IP_LIMIT_FAIL_OPEN_TIMEOUT_MS);
    } catch (err) {
      this.warnFailOpen(config.scope, err);
      return null;
    }
  }

  private warnFailOpen(scope: string, err: unknown): void {
    const now = Date.now();
    const last = this.failOpenLoggedAt.get(scope);
    if (last !== undefined && now - last < FAIL_OPEN_LOG_EVERY_MS) return;
    this.failOpenLoggedAt.set(scope, now);
    this.logger.warn(
      `IP rate-limit sin Redis (scope=${scope}): se deja pasar (página del cliente): ${(err as Error)?.message ?? String(err)}`,
    );
  }

  /** Cuenta una petición en la ventana (TTL en el primer golpe, para que se limpie sola). */
  private async hit(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }

  private async reject(
    ctx: ExecutionContext,
    req: MinimalReq,
    config: IpRateLimitConfig,
    check: { key: string; max: number; what: string },
    ip: string,
    count: number,
  ): Promise<never> {
    const ttl = await this.redis.ttl(check.key);
    const retryAfter = ttl > 0 ? ttl : config.windowSec;
    this.logger.warn(
      `IP rate-limit hit: scope=${config.scope} (${check.what}) ip=${ip} count=${count}/${check.max} retryAfter=${retryAfter}s`,
    );
    const res = ctx.switchToHttp().getResponse<{
      header?: (k: string, v: string | number) => void;
    }>();
    if (typeof res?.header === 'function') {
      res.header('Retry-After', retryAfter);
    }
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: RATE_LIMITED_MESSAGES[requestLanguage(req)],
        code: RATE_LIMITED_CODE,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * La cuenta del cuerpo (sin mayúsculas ni espacios, como la cuenta el
 * bloqueo del login), como huella: el email no queda en claro en Redis.
 */
function accountOf(body: MinimalReq['body'], field: string): string | null {
  const raw = body?.[field];
  if (typeof raw !== 'string') return null;
  const account = raw.trim().toLowerCase().slice(0, MAX_ACCOUNT_CHARS);
  return account ? createHash('sha256').update(account).digest('hex').slice(0, 32) : null;
}

/** El recurso de la petición (query o ruta), como huella: un token o un pedido nunca en claro en Redis. */
function resourceOf(req: MinimalReq, spec: { query?: string; param?: string }): string | null {
  const raw = spec.query ? req.query?.[spec.query] : spec.param ? req.params?.[spec.param] : undefined;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return createHash('sha256').update(raw.slice(0, 512)).digest('hex').slice(0, 32);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis no contestó en ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
