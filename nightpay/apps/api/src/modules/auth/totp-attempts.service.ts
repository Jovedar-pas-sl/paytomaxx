import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { LockoutService, type LockPolicy } from './lockout.service';
import { totpLockedError } from './totp-code';

/** 5 códigos malos en 15 min → 15 min sin poder probar (por usuario). */
export const TOTP_LOCK_POLICY: LockPolicy = { threshold: 5, windowSec: 15 * 60, lockSec: 15 * 60 };

/** El último paso aceptado solo hace falta mientras su código siga valiendo (±30 s). */
const LAST_STEP_TTL_SEC = 10 * 60;

/**
 * Acepta un paso solo si es posterior al último aceptado (atómico: dos
 * peticiones a la vez con el mismo código no pueden pasar las dos).
 * KEYS[1] = último paso; ARGV[1] = paso; ARGV[2] = TTL en segundos.
 */
export const CLAIM_STEP_LUA = `
local last = tonumber(redis.call('GET', KEYS[1]))
if last and tonumber(ARGV[1]) <= last then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/**
 * Límite de intentos y anti-reutilización de códigos 2FA, por usuario y en
 * Redis (vale con varias réplicas del API).
 */
@Injectable()
export class TotpAttemptsService {
  private readonly lockout: LockoutService;
  private readonly redis: Redis;

  constructor(@Inject(LockoutService) lockout: LockoutService, @Inject(REDIS_CLIENT) redis: Redis) {
    this.lockout = lockout;
    this.redis = redis;
  }

  async assertNotLocked(userId: string): Promise<void> {
    const lock = await this.lockout.isLocked(lockKey(userId));
    if (lock.locked) throw totpLockedError(lock.ttlSeconds);
  }

  /** Cuenta un código malo; devuelve true si con él queda bloqueado. */
  async recordFailure(userId: string): Promise<boolean> {
    const { locked } = await this.lockout.recordFailure(lockKey(userId), TOTP_LOCK_POLICY);
    return locked;
  }

  async clearFailures(userId: string): Promise<void> {
    await this.lockout.clear(lockKey(userId));
  }

  async claimStep(userId: string, step: number): Promise<boolean> {
    const accepted = await this.redis.eval(CLAIM_STEP_LUA, 1, lastStepKey(userId), String(step), String(LAST_STEP_TTL_SEC));
    return Number(accepted) === 1;
  }

  /** Al desactivar la 2FA: el próximo secreto empieza de cero. */
  async forgetSteps(userId: string): Promise<void> {
    await this.redis.del(lastStepKey(userId));
  }
}

function lockKey(userId: string): string {
  return `totp:${userId}`;
}

function lastStepKey(userId: string): string {
  return `nightpay:totp:last:${userId}`;
}
