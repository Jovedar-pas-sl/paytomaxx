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
import { clientIp, type ClientIpRequest } from '../http/client-ip';
import { resolveLanguage, type PayLanguage } from '../../modules/payments/pay-i18n';

/**
 * La IP real (de fiar) del cliente: ver common/http/client-ip.ts. Se
 * re-exporta aquí porque el login y otros módulos la importan de este archivo.
 */
export { clientIp };

const META_KEY = 'np:ip-rate-limit';

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
  query?: { lang?: unknown };
  body?: ({ lang?: unknown } & Record<string, unknown>) | null;
  headers?: Record<string, string | string[] | undefined>;
};

/** `code` estable del 429 (las páginas del cliente lo traducen; ver wallets/client-errors.ts). */
export const RATE_LIMITED_CODE = 'RATE_LIMITED';

/** El 429 en el idioma de la página que llama (?lang=, el `lang` del cuerpo o el del móvil). */
export const RATE_LIMITED_MESSAGES: Readonly<Record<PayLanguage, string>> = {
  es: 'Demasiados intentos seguidos: espera un momento y vuelve a probar.',
  en: 'Too many attempts in a row: wait a moment and try again.',
};

function requestLanguage(req: MinimalReq): PayLanguage {
  const accept = req.headers?.['accept-language'];
  return resolveLanguage(req.query?.lang ?? req.body?.lang, Array.isArray(accept) ? accept[0] : accept);
}

/**
 * Guard que lee el meta del handler y aplica fixed-window INCR en Redis.
 *
 * Clave Redis: nightpay:iprl:<scope>:<ip>:<windowBucket>
 * Si count > max al final del bucket → 429 Too Many Requests + Retry-After.
 *
 * Importante: este guard es GLOBAL pero solo actúa cuando el meta está set;
 * sin meta es no-op, evitando overhead en endpoints normales.
 */
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(IpRateLimitGuard.name);
  private readonly reflector: Reflector;
  private readonly redis: Redis;

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
    const account = config.perAccount ? accountOf(req.body, config.perAccount.field) : null;
    const checks: Array<{ key: string; max: number; what: string }> = [
      { key: `nightpay:iprl:${config.scope}:${ip}:${bucket}`, max: config.max, what: 'ip' },
      ...(config.perAccount && account
        ? [{ key: `nightpay:iprl:${config.scope}:acct:${ip}:${account}:${bucket}`, max: config.perAccount.max, what: 'ip+cuenta' }]
        : []),
    ];
    for (const check of checks) {
      const count = await this.hit(check.key, config.windowSec);
      if (count > check.max) await this.reject(ctx, req, config, check, ip, count);
    }
    return true;
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
