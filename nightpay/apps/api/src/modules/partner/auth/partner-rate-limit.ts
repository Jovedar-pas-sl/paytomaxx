import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { rateLimitIpKey } from '../../../common/http/client-ip';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/**
 * Topes por conexión (no por IP, como DeviceRateLimitGuard por datáfono): 600
 * llamadas por minuto y, en las rutas de dinero, además 120. Ventana fija en
 * Redis `np:prl:<all|money>:<conexión>:<minuto>`. Si Redis falla, quien llama
 * falla (503).
 *
 * Los rechazos de una clave que existe (IP ajena, anulada, en pausa, sin
 * permiso…) salen del guard antes de esos topes y no pasan por el global (la
 * exención de /v1/partner): llevan el suyo, por clave e IP (IPv6, su /64),
 * como el global por IP: `np:prl:rej:<hash>:<ip>:<minuto>`, 300 por minuto;
 * pasado, 429 sin consultar la base. Por IP, para que quien robe la clave no
 * deje sin servicio a la IP buena.
 */
export const PARTNER_RATE_LIMITS = Object.freeze({ all: 600, money: 120, rejected: 300, demoReset: 5 });

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

  /** El reinicio de las fichas de la demo: además, 5 por conexión y minuto. */
  async hitDemoReset(connectionId: string): Promise<PartnerRateResult> {
    const now = Date.now();
    const retryAfter = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
    const n = await this.count(`np:prl:demo-reset:${connectionId}:${Math.floor(now / 60_000)}`);
    return n > PARTNER_RATE_LIMITS.demoReset ? { ok: false, retryAfter } : { ok: true };
  }

  /** ¿Esta clave, desde esta IP, ya se rechazó `rejected` veces este minuto? */
  async rejectedTooOften(keyHash: string, ip: string | null): Promise<boolean> {
    return Number((await this.redis.get(this.rejectedKey(keyHash, ip))) ?? 0) >= PARTNER_RATE_LIMITS.rejected;
  }

  async recordRejection(keyHash: string, ip: string | null): Promise<void> {
    await this.count(this.rejectedKey(keyHash, ip));
  }

  private rejectedKey(keyHash: string, ip: string | null): string {
    return `np:prl:rej:${keyHash}:${ip ? rateLimitIpKey(ip) : 'desconocida'}:${Math.floor(Date.now() / 60_000)}`;
  }

  private async count(key: string): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 120);
    return n;
  }
}
