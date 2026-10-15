import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { LockoutService } from './lockout.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from './totp-attempts.service';
import { totpStepAt } from './totp-code';
import { openTotpSecret } from './totp-crypto';
import { TotpEnrollmentService } from './totp-enrollment.service';
import { TotpService } from './totp.service';
import { claimStepScript, createFakeRedis } from './testing/fake-redis';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const NOW = new Date('2026-10-15T22:00:10Z');

/** Código HTTP con el que falla la promesa (null si no falla). */
async function statusOf(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e instanceof HttpException ? e.getStatus() : -1;
  }
}

interface UserRow {
  id: string;
  email: string;
  tenantId: string;
  totpSecret: string | null;
  deletedAt: Date | null;
}

function makeUsersTable(rows: UserRow[]) {
  const users = new Map(rows.map((u) => [u.id, u]));
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: Partial<UserRow>; data: Partial<UserRow> }) => {
        const row = where.id ? users.get(where.id) : undefined;
        if (!row) return { count: 0 };
        if ('totpSecret' in where && row.totpSecret !== where.totpSecret) return { count: 0 };
        users.set(row.id, { ...row, ...data });
        return { count: 1 };
      },
    },
  };
  return { users, prisma: { acrossVenues: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
}

function makeService(rows: UserRow[]) {
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  const { users, prisma } = makeUsersTable(rows);
  const attempts = new TotpAttemptsService(new LockoutService(redis as never), redis as never);
  const totp = new TotpService(prisma as never, attempts);
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new TotpEnrollmentService(prisma as never, redis as never, totp, audit as never);
  return { svc, totp, users, redis, audit };
}

function owner(overrides: Partial<UserRow> = {}): UserRow {
  return { id: 'u1', email: 'dueno@local.es', tenantId: 't1', totpSecret: null, deletedAt: null, ...overrides };
}

function codeFor(secret: string, offsetSteps = 0): string {
  return speakeasy.totp({ secret, encoding: 'base32', counter: totpStepAt(Date.now()) + offsetSteps });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.ENCRYPTION_KEK = KEK;
});
afterEach(() => vi.useRealTimers());

describe('GET /v1/auth/totp → status', () => {
  it('dice si la tiene activada', async () => {
    const { svc } = makeService([owner(), owner({ id: 'u2', totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    expect(await svc.status('u1')).toEqual({ enabled: false });
    expect(await svc.status('u2')).toEqual({ enabled: true });
  });

  it('usuario dado de baja → 401', async () => {
    const { svc } = makeService([owner({ deletedAt: new Date() })]);
    await expect(svc.status('u1')).rejects.toThrow(UnauthorizedException);
  });
});

describe('POST /v1/auth/totp/setup', () => {
  it('devuelve QR, URL y secreto; el pendiente queda cifrado en Redis 10 min', async () => {
    const { svc, redis } = makeService([owner()]);
    const res = await svc.setup('u1');

    expect(res.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.otpauthUrl).toMatch(/^otpauth:\/\/totp\/OxioPay:dueno%40local\.es\?secret=[A-Z2-7]+&issuer=OxioPay/);
    expect(res.otpauthUrl).toContain(`secret=${res.secret}`);
    expect(res.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);

    const pending = await redis.get('nightpay:totp:pending:u1');
    expect(pending).not.toContain(res.secret);
    expect(openTotpSecret(pending!, KEK).secret).toBe(res.secret);
    expect(await redis.ttl('nightpay:totp:pending:u1')).toBe(600);
  });

  it('repetido dentro de los 10 min → el mismo secreto (recargar la pantalla no rompe el QR escaneado)', async () => {
    const { svc } = makeService([owner()]);
    const first = await svc.setup('u1');
    vi.advanceTimersByTime(60_000);
    expect((await svc.setup('u1')).secret).toBe(first.secret);
  });

  it('ya activada → 409', async () => {
    const { svc } = makeService([owner({ totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    await expect(svc.setup('u1')).rejects.toThrow(ConflictException);
  });
});

describe('POST /v1/auth/totp/confirm', () => {
  it('con el código bueno: guarda el secreto cifrado, borra el pendiente y lo apunta', async () => {
    const { svc, users, redis, audit } = makeService([owner()]);
    const { secret } = await svc.setup('u1');

    expect(await svc.confirm('u1', codeFor(secret), { ip: '1.2.3.4' })).toEqual({ enabled: true });

    const stored = users.get('u1')!.totpSecret!;
    expect(stored.startsWith('tv1:')).toBe(true);
    expect(openTotpSecret(stored, KEK).secret).toBe(secret);
    expect(await redis.get('nightpay:totp:pending:u1')).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.totp.enabled', actorId: 'u1', tenantId: 't1', ip: '1.2.3.4' }),
    );
    expect(await svc.status('u1')).toEqual({ enabled: true });
  });

  it('el código usado para activar no vale después para pagar', async () => {
    const { svc, totp } = makeService([owner()]);
    const { secret } = await svc.setup('u1');
    const code = codeFor(secret);
    await svc.confirm('u1', code);
    await expect(totp.assertForUser('u1', code)).rejects.toThrow(/ya se ha usado/);
  });

  it('código malo → 403 y la 2FA sigue sin activar', async () => {
    const { svc, users } = makeService([owner()]);
    await svc.setup('u1');
    await expect(svc.confirm('u1', '000000')).rejects.toThrow(ForbiddenException);
    expect(users.get('u1')!.totpSecret).toBeNull();
  });

  it('5 códigos malos → 429', async () => {
    const { svc } = makeService([owner()]);
    await svc.setup('u1');
    for (let i = 0; i < 4; i++) await expect(svc.confirm('u1', '000000')).rejects.toThrow(ForbiddenException);
    expect(await statusOf(svc.confirm('u1', '000000'))).toBe(429);
  });

  it('sin activación en curso (o caducada a los 10 min) → 409', async () => {
    const { svc } = makeService([owner()]);
    await expect(svc.confirm('u1', '123456')).rejects.toThrow(/No hay ninguna activación/);

    const { secret } = await svc.setup('u1');
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(svc.confirm('u1', codeFor(secret))).rejects.toThrow(ConflictException);
  });

  it('ya activada → 409', async () => {
    const { svc } = makeService([owner({ totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    await expect(svc.confirm('u1', '123456')).rejects.toThrow(ConflictException);
  });
});

describe('POST /v1/auth/totp/disable', () => {
  async function enrolled() {
    const made = makeService([owner()]);
    const { secret } = await made.svc.setup('u1');
    await made.svc.confirm('u1', codeFor(secret, -1));
    return { ...made, secret };
  }

  it('con un código bueno la quita y lo apunta', async () => {
    const { svc, users, audit, secret } = await enrolled();
    expect(await svc.disable('u1', codeFor(secret))).toEqual({ enabled: false });
    expect(users.get('u1')!.totpSecret).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.totp.disabled', actorId: 'u1' }));
  });

  it('código malo → 403 y sigue activada', async () => {
    const { svc, users } = await enrolled();
    await expect(svc.disable('u1', '000000')).rejects.toThrow(ForbiddenException);
    expect(users.get('u1')!.totpSecret).not.toBeNull();
  });

  it('no activada → 409', async () => {
    const { svc } = makeService([owner()]);
    await expect(svc.disable('u1', '123456')).rejects.toThrow(ConflictException);
  });

  it('funciona también con un secreto antiguo guardado en claro', async () => {
    const legacy = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const { svc, users } = makeService([owner({ totpSecret: legacy })]);
    expect(await svc.disable('u1', codeFor(legacy))).toEqual({ enabled: false });
    expect(users.get('u1')!.totpSecret).toBeNull();
  });

  it('tras desactivar se puede volver a activar enseguida', async () => {
    const { svc, secret } = await enrolled();
    await svc.disable('u1', codeFor(secret));
    const again = await svc.setup('u1');
    expect(await svc.confirm('u1', codeFor(again.secret))).toEqual({ enabled: true });
  });
});
