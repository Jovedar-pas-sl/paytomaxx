/**
 * TotpService de verdad sobre un Redis en memoria y usuarios de mentira, para
 * los tests (no es código de producción). Dos kits con el mismo `redis` son
 * dos réplicas del API.
 */
import * as speakeasy from 'speakeasy';
import { LockoutService } from '../lockout.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../totp-attempts.service';
import { totpStepAt } from '../totp-code';
import { TotpService } from '../totp.service';
import { claimStepScript, createFakeRedis, type FakeRedis } from './fake-redis';

export interface TotpUserUpdate {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

export interface TotpKit {
  readonly totp: TotpService;
  readonly redis: FakeRedis;
  /** users.updateMany que ha hecho el servicio (re-cifrado de secretos antiguos). */
  readonly updates: TotpUserUpdate[];
}

/** `users`: id → lo guardado en users.totpSecret (null = sin 2FA). */
export function makeTotpKit(opts: { redis?: FakeRedis; users?: Record<string, string | null> } = {}): TotpKit {
  const redis = opts.redis ?? createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  const users = new Map(Object.entries(opts.users ?? {}));
  const updates: TotpUserUpdate[] = [];
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.has(where.id) ? { totpSecret: users.get(where.id) ?? null } : null,
      updateMany: async (args: TotpUserUpdate) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const prisma = { acrossVenues: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  const attempts = new TotpAttemptsService(new LockoutService(redis as never), redis as never);
  return { totp: new TotpService(prisma as never, attempts), redis, updates };
}

/** Código de la app para ese secreto en ese paso de 30 s (por defecto, el de ahora). */
export function totpCodeAt(secretBase32: string, step = totpStepAt(Date.now())): string {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32', counter: step });
}
