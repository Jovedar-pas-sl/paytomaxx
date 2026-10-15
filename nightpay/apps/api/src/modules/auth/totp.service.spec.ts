import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { LockoutService } from './lockout.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from './totp-attempts.service';
import { totpStepAt } from './totp-code';
import { openTotpSecret, sealTotpSecret } from './totp-crypto';
import { TotpService } from './totp.service';
import { claimStepScript, createFakeRedis, type FakeRedis } from './testing/fake-redis';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const NOW = new Date('2026-10-15T22:00:10Z');
const STEP = totpStepAt(NOW.getTime());

function codeAt(secret: string, step = STEP): string {
  return speakeasy.totp({ secret, encoding: 'base32', counter: step });
}

function makeService(opts: { redis?: FakeRedis; users?: Record<string, string | null> } = {}) {
  const redis = opts.redis ?? createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  const users = new Map(Object.entries(opts.users ?? {}));
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        users.has(where.id) ? { totpSecret: users.get(where.id) ?? null } : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const attempts = new TotpAttemptsService(new LockoutService(redis as never), redis as never);
  const totp = new TotpService(prisma as never, attempts);
  return { totp, tx, redis };
}

/** Deja correr las tareas en segundo plano (re-cifrado del secreto antiguo). */
async function flushBackground(): Promise<void> {
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.ENCRYPTION_KEK = KEK;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('generateSecret', () => {
  it('secreto base32 + URL otpauth con la marca como emisor', () => {
    const { totp } = makeService();
    const { base32, otpauthUrl } = totp.generateSecret('dueno@local.es', 'OxioPay');
    expect(base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/OxioPay:dueno%40local\.es\?secret=[A-Z2-7]+&issuer=OxioPay/);
  });
});

describe('API síncrona (assertIfEnrolled / verify: la usan refunds y el pago a operadoras)', () => {
  it('sin 2FA activada → pasa como antes (no bloquea a nadie)', () => {
    const { totp } = makeService();
    expect(() => totp.assertIfEnrolled(null, undefined)).not.toThrow();
  });

  it('con 2FA activada: sin código o con uno incorrecto → 403', () => {
    const { totp } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    expect(() => totp.assertIfEnrolled(base32, undefined)).toThrow(ForbiddenException);
    expect(() => totp.assertIfEnrolled(base32, '000000')).toThrow(/incorrecto/);
  });

  it('con 2FA activada y el código de la app → pasa (secreto cifrado o antiguo en claro)', () => {
    const { totp } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    expect(() => totp.assertIfEnrolled(totp.sealSecret(base32), codeAt(base32))).not.toThrow();

    const other = totp.generateSecret('otro@local.es').base32;
    expect(() => totp.assertIfEnrolled(other, codeAt(other))).not.toThrow();
  });

  it('el mismo código no vale dos veces, ni uno anterior al último aceptado', () => {
    const { totp } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    const stored = totp.sealSecret(base32);
    expect(totp.verify(stored, codeAt(base32, STEP))).toBe(true);
    expect(() => totp.assertIfEnrolled(stored, codeAt(base32, STEP))).toThrow(/ya se ha usado/);
    expect(totp.verify(stored, codeAt(base32, STEP - 1))).toBe(false);
    expect(totp.verify(stored, codeAt(base32, STEP + 1))).toBe(true);
  });

  it('5 códigos malos bloquean 15 min (429), aunque luego llegue el bueno', () => {
    const { totp } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    for (let i = 0; i < 4; i++) expect(() => totp.assertIfEnrolled(base32, '000000')).toThrow(ForbiddenException);
    const locked = (() => {
      try {
        totp.assertIfEnrolled(base32, '000000');
      } catch (e) {
        return e as HttpException;
      }
      return null;
    })();
    expect(locked?.getStatus()).toBe(429);
    expect(totp.verify(base32, codeAt(base32))).toBe(false);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(totp.verify(base32, codeAt(base32, totpStepAt(Date.now())))).toBe(true);
  });

  it('secreto antiguo en claro: al acertar se guarda cifrado (en segundo plano)', async () => {
    const { totp, tx } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    totp.assertIfEnrolled(base32, codeAt(base32));
    await flushBackground();

    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
    const call = tx.user.updateMany.mock.calls[0] as unknown as [
      { where: { totpSecret: string }; data: { totpSecret: string } },
    ];
    expect(call[0].where).toEqual({ totpSecret: base32 });
    expect(openTotpSecret(call[0].data.totpSecret, KEK)).toEqual({ secret: base32, legacy: false });
  });

  it('secreto cifrado con otra clave → 403 claro (no 500)', () => {
    const { totp } = makeService();
    const { base32 } = totp.generateSecret('dueno@local.es');
    const sealedElsewhere = sealTotpSecret(base32, `${KEK}-otra`);
    expect(() => totp.assertIfEnrolled(sealedElsewhere, codeAt(base32))).toThrow(/No se puede comprobar/);
    expect(totp.verify(sealedElsewhere, codeAt(base32))).toBe(false);
  });
});

describe('API por usuario (Redis): assertIfEnrolledForUser / assertForUser', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('sin 2FA: assertIfEnrolledForUser deja pasar; assertForUser exige activarla', async () => {
    const { totp } = makeService({ users: { u1: null } });
    await expect(totp.assertIfEnrolledForUser('u1', undefined)).resolves.toBeUndefined();
    await expect(totp.assertForUser('u1', '123456')).rejects.toThrow(/Activa antes/);
    expect(await totp.isEnabled('u1')).toBe(false);
  });

  it('código bueno pasa; repetido o malo → 403; 5 fallos → 429', async () => {
    const { totp } = makeService({ users: { u1: sealTotpSecret(secret, KEK) } });
    expect(await totp.isEnabled('u1')).toBe(true);
    await expect(totp.assertForUser('u1', codeAt(secret))).resolves.toBeUndefined();
    await expect(totp.assertForUser('u1', codeAt(secret))).rejects.toThrow(/ya se ha usado/);
    await expect(totp.assertIfEnrolledForUser('u1', undefined)).rejects.toThrow(/Pon el código/);

    for (let i = 0; i < 3; i++) await expect(totp.assertForUser('u1', '000000')).rejects.toThrow(/incorrecto/);
    const err = await totp.assertForUser('u1', '000000').catch((e: unknown) => e as HttpException);
    expect(err.getStatus()).toBe(429);
    await expect(totp.assertForUser('u1', codeAt(secret, STEP + 1))).rejects.toThrow(/Demasiados/);
  });

  it('el límite y el anti-reutilización valen entre réplicas (mismo Redis)', async () => {
    const redis = createFakeRedis();
    const users = { u1: sealTotpSecret(secret, KEK) };
    const a = makeService({ redis, users }).totp;
    const b = makeService({ redis, users }).totp;
    await a.assertForUser('u1', codeAt(secret));
    await expect(b.assertForUser('u1', codeAt(secret))).rejects.toThrow(/ya se ha usado/);
  });

  it('secreto antiguo en claro: se guarda cifrado tras acertar', async () => {
    const { totp, tx } = makeService({ users: { u1: secret } });
    await totp.assertForUser('u1', codeAt(secret));
    const call = tx.user.updateMany.mock.calls[0] as unknown as [
      { where: { id: string; totpSecret: string }; data: { totpSecret: string } },
    ];
    expect(call[0].where).toEqual({ id: 'u1', totpSecret: secret });
    expect(openTotpSecret(call[0].data.totpSecret, KEK).secret).toBe(secret);
  });
});
