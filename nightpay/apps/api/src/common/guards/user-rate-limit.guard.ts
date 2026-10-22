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
import { RATE_LIMITED_CODE, RATE_LIMITED_MESSAGES } from './ip-rate-limit.guard';

const META_KEY = 'np:user-rate-limit';

export interface UserRateLimitConfig {
  max: number;
  windowSec: number;
  scope: string;
}

/**
 * Tope por persona (no por IP): en un local todo el personal comparte el wifi
 * y una persona puede cambiar de red. Va con @UseGuards(UserRateLimitGuard),
 * detrás de la sesión (req.user). Sin persona no frena: la ruta ya lo exige.
 */
export const UserRateLimit = (config: UserRateLimitConfig) => SetMetadata(META_KEY, config);

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);
  private readonly reflector: Reflector;
  private readonly redis: Pick<Redis, 'incr' | 'expire' | 'ttl'>;

  constructor(@Inject(Reflector) reflector: Reflector, @Inject(REDIS_CLIENT) redis: Redis) {
    this.reflector = reflector;
    this.redis = redis;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<UserRateLimitConfig | undefined>(META_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!config) return true;
    const userId = ctx.switchToHttp().getRequest<{ user?: { sub?: string } }>().user?.sub;
    if (!userId) return true;
    const bucket = Math.floor(Date.now() / 1000 / config.windowSec);
    const key = `nightpay:userrl:${config.scope}:${userId}:${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, config.windowSec);
    if (count <= config.max) return true;
    const ttl = await this.redis.ttl(key);
    const retryAfter = ttl > 0 ? ttl : config.windowSec;
    this.logger.warn(`Tope por persona: scope=${config.scope} user=${userId} ${count}/${config.max}`);
    const res = ctx.switchToHttp().getResponse<{ header?: (k: string, v: string | number) => void }>();
    if (typeof res?.header === 'function') res.header('Retry-After', retryAfter);
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: RATE_LIMITED_MESSAGES.es, code: RATE_LIMITED_CODE, retryAfter },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
