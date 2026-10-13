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
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const META_KEY = 'np:ip-rate-limit';

export interface IpRateLimitConfig {
  /** Tope de requests permitidos en la ventana. */
  max: number;
  /** Tamaño de la ventana en segundos. */
  windowSec: number;
  /** Tag corto para identificar el bucket Redis (p.ej. 'auth-login'). */
  scope: string;
}

/**
 * Decorator para aplicar un rate-limit por IP MUY estricto a un handler.
 * Pensado para endpoints sensibles (login, refresh, accept-invite, password-reset)
 * donde el global de 100/min es demasiado laxo y el atacante puede enumerar.
 *
 * @example
 *   @Post('login')
 *   @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-login' })
 *   async login(...) { ... }
 */
export const IpRateLimit = (config: IpRateLimitConfig) =>
  SetMetadata(META_KEY, config);

interface MinimalReq {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
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
    const ip = extractIp(req);
    if (!ip) return true; // sin IP confiable no rate-limitamos (raro pero defensivo)

    // Fixed window: bucket = floor(now / windowSec). Reset implícito al cambiar bucket.
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / config.windowSec);
    const key = `nightpay:iprl:${config.scope}:${ip}:${bucket}`;

    const count = await this.redis.incr(key);
    if (count === 1) {
      // primer hit en este bucket: TTL = windowSec para auto-limpieza
      await this.redis.expire(key, config.windowSec);
    }

    if (count > config.max) {
      const ttl = await this.redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : config.windowSec;
      this.logger.warn(
        `IP rate-limit hit: scope=${config.scope} ip=${ip} count=${count}/${config.max} retryAfter=${retryAfter}s`,
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
          message: 'Too Many Requests',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/**
 * Extrae la IP real. Detrás de Cloudflare manda CF-Connecting-IP: lo pone
 * Cloudflare y el cliente no puede falsearlo (el primer valor de
 * X-Forwarded-For sí). Sin él, X-Forwarded-For; en dev, socket.remoteAddress.
 */
function extractIp(req: MinimalReq): string | null {
  const cf = req.headers['cf-connecting-ip'];
  const cfStr = Array.isArray(cf) ? cf[0] : cf;
  if (typeof cfStr === 'string' && cfStr.trim().length > 0) return cfStr.trim();
  const xff = req.headers['x-forwarded-for'];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffStr === 'string' && xffStr.length > 0) {
    const first = xffStr.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
