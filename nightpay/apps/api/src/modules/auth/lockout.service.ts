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

/** Una clave de bloqueo para reserveAttempt. */
export interface AttemptGate {
  readonly key: string;
  readonly policy: LockPolicy;
  /** false = si está bloqueada no rechaza (p. ej. la cuenta desde una IP de confianza); se cuenta igual. */
  readonly enforce?: boolean;
}

export type AttemptReservation =
  | { readonly allowed: true; readonly counts: readonly number[] }
  | { readonly allowed: false; readonly gate: number; readonly ttlSeconds: number };

/**
 * Comprobar el bloqueo y contar el intento, en un paso (Redis ejecuta el
 * script entero sin intercalar nada): 20 peticiones a la vez no prueban 20
 * contraseñas aunque bcrypt tarde. Con varias claves, si alguna que cuenta
 * está bloqueada no se cuenta en ninguna.
 * KEYS = (fallos, bloqueo) por clave. ARGV = (umbral, ventana, bloqueo, enforce) por clave.
 * Devuelve {1, cuenta1, cuenta2…} o {0, nº de clave (desde 1), segundos que quedan}.
 */
export const RESERVE_ATTEMPT_LUA = `
local n = #KEYS / 2
for i = 1, n do
  if ARGV[(i - 1) * 4 + 4] == '1' then
    local ttl = redis.call('TTL', KEYS[i * 2])
    if ttl > 0 then return {0, i, ttl} end
  end
end
local out = {1}
for i = 1, n do
  local fail, locked, a = KEYS[i * 2 - 1], KEYS[i * 2], (i - 1) * 4
  local c = redis.call('INCR', fail)
  if c == 1 then redis.call('EXPIRE', fail, tonumber(ARGV[a + 2])) end
  if c >= tonumber(ARGV[a + 1]) then
    redis.call('SET', locked, '1', 'EX', tonumber(ARGV[a + 3]), 'NX')
    redis.call('DEL', fail)
  end
  out[i + 1] = c
end
return out
`;

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

  /**
   * Reserva el intento ANTES de mirar la contraseña (RESERVE_ATTEMPT_LUA): el
   * intento cuenta como fallo hasta que clear() lo borra con un acierto. El
   * que llega al umbral deja la clave bloqueada (un acierto la desbloquea).
   */
  async reserveAttempt(gates: readonly AttemptGate[]): Promise<AttemptReservation> {
    const keys = gates.flatMap((g) => [failKey(g.key), lockedKey(g.key)]);
    const args = gates.flatMap((g) => [
      String(g.policy.threshold),
      String(g.policy.windowSec),
      String(g.policy.lockSec),
      g.enforce === false ? '0' : '1',
    ]);
    const raw = (await this.redis.eval(RESERVE_ATTEMPT_LUA, keys.length, ...keys, ...args)) as number[];
    const [ok, ...rest] = raw.map(Number);
    if (ok === 1) {
      gates.forEach((g, i) => {
        if ((rest[i] ?? 0) >= g.policy.threshold) this.logger.warn(`Locked ${g.key} for ${g.policy.lockSec}s`);
      });
      return { allowed: true, counts: rest };
    }
    return { allowed: false, gate: (rest[0] ?? 1) - 1, ttlSeconds: rest[1] ?? 0 };
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
