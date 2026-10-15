import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export interface LockPolicy {
  /** Fallos dentro de la ventana que activan el bloqueo. */
  readonly threshold: number;
  /** Ventana fija desde el primer fallo: más fallos no la alargan. */
  readonly windowSec: number;
  /** Duración del bloqueo: mientras dura, no se alarga. */
  readonly lockSec: number;
}

/**
 * Política de bloqueos del login (y de los códigos 2FA, ver totp-attempts):
 *
 * - Por IP (email|IP, IPv6 agrupada por /64): 5 fallos en 15 min → esa IP
 *   queda fuera 15 min para esa cuenta. Es el freno principal: una sola IP
 *   aporta como mucho 5 fallos cada 15 min.
 * - Por cuenta (cualquier IP): 30 fallos en 15 min → bloqueo CORTO de 5 min.
 *   Una sola IP nunca llega a 30, así que hace falta un ataque repartido.
 *   El bloqueo no se alarga mientras dura (SET NX) y al saltar el contador
 *   vuelve a cero: para mantener la cuenta cerrada hacen falta otros 30
 *   fallos desde IPs nuevas cada 5 min.
 * - Las parejas email|IP que ya entraron bien (30 días) no sufren el bloqueo
 *   por cuenta, solo el suyo por IP: con un ataque repartido en marcha, el
 *   dueño sigue entrando desde el local o desde casa.
 */
export const PER_IP_POLICY: LockPolicy = { threshold: 5, windowSec: 15 * 60, lockSec: 15 * 60 };
export const ACCOUNT_POLICY: LockPolicy = { threshold: 30, windowSec: 15 * 60, lockSec: 5 * 60 };

const TRUSTED_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * Lockout multi-nodo via Redis.
 *
 * Claves:
 *   nightpay:lockout:fail:<key>     -> contador (TTL = ventana, desde el primer fallo)
 *   nightpay:lockout:locked:<key>   -> '1' (TTL = bloqueo, presencia = bloqueado)
 *   nightpay:lockout:trusted:<key>  -> '1' (TTL 30 d, email|IP que ya entró bien)
 */
@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);
  private readonly redis: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  async isLocked(key: string): Promise<{ locked: boolean; ttlSeconds: number }> {
    const ttl = await this.redis.ttl(lockedKey(key));
    return { locked: ttl > 0, ttlSeconds: ttl > 0 ? ttl : 0 };
  }

  /**
   * Registra un fallo. Al llegar al umbral bloquea (sin alargar un bloqueo en
   * curso) y pone el contador a cero. Devuelve el contador y si quedó bloqueado.
   */
  async recordFailure(key: string, policy: LockPolicy = PER_IP_POLICY): Promise<{ count: number; locked: boolean }> {
    const counter = failKey(key);
    const count = await this.redis.incr(counter);
    if (count === 1) {
      await this.redis.expire(counter, policy.windowSec);
    }
    if (count < policy.threshold) return { count, locked: false };

    await this.redis.set(lockedKey(key), '1', 'EX', policy.lockSec, 'NX');
    await this.redis.del(counter);
    this.logger.warn(`Locked ${key} (count=${count}) for ${policy.lockSec}s`);
    return { count, locked: true };
  }

  /** Limpia contador y lock (login exitoso). */
  async clear(key: string): Promise<void> {
    await this.redis.del(failKey(key), lockedKey(key));
  }

  async markTrusted(key: string): Promise<void> {
    await this.redis.set(trustedKey(key), '1', 'EX', TRUSTED_TTL_SEC);
  }

  async isTrusted(key: string): Promise<boolean> {
    return (await this.redis.get(trustedKey(key))) !== null;
  }
}

function failKey(key: string): string {
  return `nightpay:lockout:fail:${key}`;
}

function lockedKey(key: string): string {
  return `nightpay:lockout:locked:${key}`;
}

function trustedKey(key: string): string {
  return `nightpay:lockout:trusted:${key}`;
}
