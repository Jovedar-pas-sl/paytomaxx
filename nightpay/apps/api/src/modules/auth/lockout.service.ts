import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

const FAILED_THRESHOLD = 5;
const FAILURE_WINDOW_SEC = 15 * 60; // contador de intentos en ventana 15min
const LOCKOUT_DURATION_SEC = 15 * 60; // bloqueo 15min tras hit threshold

/**
 * Lockout multi-nodo via Redis.
 *
 * Claves:
 *   nightpay:lockout:fail:<key>    -> contador (TTL 15min, se renueva con cada fallo)
 *   nightpay:lockout:locked:<key>  -> '1' (TTL 15min, presencia = bloqueado)
 *
 * `key` normalmente es email lowercased; opcionalmente concatenar IP.
 */
@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);
  private readonly redis: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  async isLocked(key: string): Promise<{ locked: boolean; ttlSeconds: number }> {
    const k = `nightpay:lockout:locked:${key}`;
    const ttl = await this.redis.ttl(k);
    return { locked: ttl > 0, ttlSeconds: ttl > 0 ? ttl : 0 };
  }

  /**
   * Registra un fallo. Si supera threshold, activa el lock.
   * Devuelve el contador actual y si quedo locked.
   */
  async recordFailure(key: string): Promise<{ count: number; locked: boolean }> {
    const failKey = `nightpay:lockout:fail:${key}`;
    const lockedKey = `nightpay:lockout:locked:${key}`;
    const count = await this.redis.incr(failKey);
    if (count === 1) {
      // Primera falla — set TTL
      await this.redis.expire(failKey, FAILURE_WINDOW_SEC);
    }
    if (count >= FAILED_THRESHOLD) {
      await this.redis.set(lockedKey, '1', 'EX', LOCKOUT_DURATION_SEC);
      this.logger.warn(`Locked ${key} (count=${count}) for ${LOCKOUT_DURATION_SEC}s`);
      return { count, locked: true };
    }
    return { count, locked: false };
  }

  /** Limpia contador y lock (login exitoso). */
  async clear(key: string): Promise<void> {
    await Promise.all([
      this.redis.del(`nightpay:lockout:fail:${key}`),
      this.redis.del(`nightpay:lockout:locked:${key}`),
    ]);
  }
}
