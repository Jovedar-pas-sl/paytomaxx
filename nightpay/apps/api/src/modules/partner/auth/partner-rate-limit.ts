import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/**
 * Topes por conexión (no por IP, como DeviceRateLimitGuard por datáfono): 600
 * llamadas por minuto y, en las rutas de dinero, además 120. Ventana fija en
 * Redis `np:prl:<all|money>:<conexión>:<minuto>`. Si Redis falla, quien llama
 * falla (503).
 */
export const PARTNER_RATE_LIMITS = Object.freeze({ all: 600, money: 120 });

export type PartnerRateResult = { ok: true } | { ok: false; retryAfter: number };

@Injectable()
export class PartnerRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async hit(connectionId: string, money: boolean): Promise<PartnerRateResult> {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const retryAfter = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
    if ((await this.count(`np:prl:all:${connectionId}:${minute}`)) > PARTNER_RATE_LIMITS.all) return { ok: false, retryAfter };
    if (money && (await this.count(`np:prl:money:${connectionId}:${minute}`)) > PARTNER_RATE_LIMITS.money) {
      return { ok: false, retryAfter };
    }
    return { ok: true };
  }

  private async count(key: string): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 120);
    return n;
  }
}
