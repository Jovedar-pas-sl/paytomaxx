import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
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
const PASSWORD = 'Clave-del-dueno-1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
/** sid del access token (la sesión que empieza la activación). */
const SID = 'fam-1';

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
  passwordHash: string;
  deletedAt: Date | null;
  isSuperAdmin?: boolean;
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
  const lockout = new LockoutService(redis as never);
  const attempts = new TotpAttemptsService(lockout, redis as never);
  const totp = new TotpService(prisma as never, attempts);
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const telegram = { send: vi.fn().mockResolvedValue(true) };
  const svc = new TotpEnrollmentService(prisma as never, redis as never, totp, audit as never, lockout, telegram as never);
  return { svc, totp, users, redis, audit, telegram };
}

function owner(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u1',
    email: 'dueno@local.es',
    tenantId: 't1',
    totpSecret: null,
    passwordHash: PASSWORD_HASH,
    deletedAt: null,
    ...overrides,
  };
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
    const res = await svc.setup('u1', PASSWORD, SID);

    expect(res.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.otpauthUrl).toMatch(/^otpauth:\/\/totp\/OxioPay:dueno%40local\.es\?secret=[A-Z2-7]+&issuer=OxioPay/);
    expect(res.otpauthUrl).toContain(`secret=${res.secret}`);
    expect(res.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);

    const pending = await redis.get('nightpay:totp:pending:u1');
    expect(pending).not.toContain(res.secret);
    const { sealed, sid } = JSON.parse(pending!) as { sealed: string; sid: string };
    expect(sid).toBe(SID);
    expect(openTotpSecret(sealed, KEK).secret).toBe(res.secret);
    expect(await redis.ttl('nightpay:totp:pending:u1')).toBe(600);
  });

  it('repetido dentro de los 10 min → el mismo secreto (recargar la pantalla no rompe el QR escaneado)', async () => {
    const { svc } = makeService([owner()]);
    const first = await svc.setup('u1', PASSWORD, SID);
    vi.advanceTimersByTime(60_000);
    expect((await svc.setup('u1', PASSWORD, SID)).secret).toBe(first.secret);
  });

  it('desde otra sesión (o sin sid) → secreto nuevo; el que se enseñó antes ya no activa', async () => {
    const { svc } = makeService([owner()]);
    const first = await svc.setup('u1', PASSWORD, SID);
    const other = await svc.setup('u1', PASSWORD, 'fam-otra');
    expect(other.secret).not.toBe(first.secret);
    const noSid = await svc.setup('u1', PASSWORD);
    expect(noSid.secret).not.toBe(other.secret);
    expect((await svc.setup('u1', PASSWORD)).secret).not.toBe(noSid.secret);
    await expect(svc.confirm('u1', codeFor(first.secret), PASSWORD)).rejects.toThrow(ForbiddenException);
  });

  it('pide la contraseña actual: mal → 403 PASSWORD_INVALID, sin secreto pendiente y apuntado', async () => {
    const { svc, redis, audit } = makeService([owner()]);
    const err = await svc.setup('u1', 'otra-cosa', SID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'PASSWORD_INVALID' });
    expect(await redis.get('nightpay:totp:pending:u1')).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.totp.password_failed', actorId: 'u1' }));
  });

  it('5 contraseñas malas → 429 durante 15 min, también con la buena', async () => {
    const { svc } = makeService([owner()]);
    for (let i = 0; i < 4; i++) expect(await statusOf(svc.setup('u1', 'mala', SID))).toBe(403);
    expect(await statusOf(svc.setup('u1', 'mala', SID))).toBe(403);
    expect(await statusOf(svc.setup('u1', PASSWORD, SID))).toBe(429);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(await statusOf(svc.setup('u1', PASSWORD, SID))).toBeNull();
  });

  it('la contraseña buena borra los fallos de antes', async () => {
    const { svc } = makeService([owner()]);
    for (let i = 0; i < 4; i++) expect(await statusOf(svc.setup('u1', 'mala', SID))).toBe(403);
    await svc.setup('u1', PASSWORD, SID);
    for (let i = 0; i < 4; i++) expect(await statusOf(svc.setup('u1', 'mala', SID))).toBe(403);
    expect(await statusOf(svc.setup('u1', PASSWORD, SID))).toBeNull();
  });

  it('ya activada → 409', async () => {
    const { svc } = makeService([owner({ totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    await expect(svc.setup('u1', PASSWORD, SID)).rejects.toThrow(ConflictException);
  });
});

describe('POST /v1/auth/totp/confirm', () => {
  it('con el código bueno: guarda el secreto cifrado, borra el pendiente y lo apunta', async () => {
    const { svc, users, redis, audit } = makeService([owner()]);
    const { secret } = await svc.setup('u1', PASSWORD, SID);

    expect(await svc.confirm('u1', codeFor(secret), PASSWORD, { ip: '1.2.3.4' })).toEqual({ enabled: true });

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
    const { secret } = await svc.setup('u1', PASSWORD, SID);
    const code = codeFor(secret);
    await svc.confirm('u1', code, PASSWORD);
    await expect(totp.assertForUser('u1', code)).rejects.toThrow(/ya se ha usado/);
  });

  it('contraseña mala → 403 y la 2FA sigue sin activar (el código no se llega a mirar)', async () => {
    const { svc, users } = makeService([owner()]);
    const { secret } = await svc.setup('u1', PASSWORD, SID);
    const err = await svc.confirm('u1', codeFor(secret), 'otra-cosa').catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'PASSWORD_INVALID' });
    expect(users.get('u1')!.totpSecret).toBeNull();
    // El código sigue valiendo con la contraseña buena.
    expect(await svc.confirm('u1', codeFor(secret), PASSWORD)).toEqual({ enabled: true });
  });

  it('activación pendiente de antes de esta versión (el secreto cifrado tal cual) → se puede confirmar', async () => {
    const { svc, totp, redis } = makeService([owner()]);
    const secret = totp.newSecret();
    await redis.set('nightpay:totp:pending:u1', totp.sealSecret(secret), 'EX', 600);
    expect(await svc.confirm('u1', codeFor(secret), PASSWORD)).toEqual({ enabled: true });
  });

  it('código malo → 403 y la 2FA sigue sin activar', async () => {
    const { svc, users } = makeService([owner()]);
    await svc.setup('u1', PASSWORD, SID);
    await expect(svc.confirm('u1', '000000', PASSWORD)).rejects.toThrow(ForbiddenException);
    expect(users.get('u1')!.totpSecret).toBeNull();
  });

  it('5 códigos malos → 429', async () => {
    const { svc } = makeService([owner()]);
    await svc.setup('u1', PASSWORD, SID);
    for (let i = 0; i < 4; i++) await expect(svc.confirm('u1', '000000', PASSWORD)).rejects.toThrow(ForbiddenException);
    expect(await statusOf(svc.confirm('u1', '000000', PASSWORD))).toBe(429);
  });

  it('sin activación en curso (o caducada a los 10 min) → 409', async () => {
    const { svc } = makeService([owner()]);
    await expect(svc.confirm('u1', '123456', PASSWORD)).rejects.toThrow(/No hay ninguna activación/);

    const { secret } = await svc.setup('u1', PASSWORD, SID);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(svc.confirm('u1', codeFor(secret), PASSWORD)).rejects.toThrow(ConflictException);
  });

  it('ya activada → 409', async () => {
    const { svc } = makeService([owner({ totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    await expect(svc.confirm('u1', '123456', PASSWORD)).rejects.toThrow(ConflictException);
  });
});

describe('POST /v1/auth/totp/disable', () => {
  async function enrolled() {
    const made = makeService([owner()]);
    const { secret } = await made.svc.setup('u1', PASSWORD, SID);
    await made.svc.confirm('u1', codeFor(secret, -1), PASSWORD);
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
    const again = await svc.setup('u1', PASSWORD, SID);
    expect(await svc.confirm('u1', codeFor(again.secret), PASSWORD)).toEqual({ enabled: true });
  });
});

describe('super-admin sin 2FA: activarla en el login (con el ticket de la contraseña)', () => {
  const SCOPE = 'login:0123456789abcdef0123456789abcdef';

  afterEach(() => vi.unstubAllEnvs());

  it('setupAtLogin da el QR sin pedir la contraseña; confirmAtLogin lo guarda, lo apunta y avisa por Telegram', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { svc, users, audit, telegram } = makeService([owner({ isSuperAdmin: true })]);
    const { secret } = await svc.setupAtLogin('u1', SCOPE);
    expect((await svc.setupAtLogin('u1', SCOPE)).secret).toBe(secret);

    await svc.confirmAtLogin('u1', codeFor(secret), SCOPE, { ip: '1.2.3.4' });
    expect(openTotpSecret(users.get('u1')!.totpSecret!, KEK).secret).toBe(secret);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.totp.enabled', actorId: 'u1', payload: { superAdmin: true, via: 'login' } }),
    );
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).toMatch(/super-admin dueno@local\.es desde la IP 1\.2\.3\.4/);
  });

  it('el QR de otro ticket (o de Ajustes) no vale aquí → 409', async () => {
    const { svc, users } = makeService([owner({ isSuperAdmin: true })]);
    const { secret } = await svc.setupAtLogin('u1', 'login:otro');
    expect(await statusOf(svc.confirmAtLogin('u1', codeFor(secret), SCOPE))).toBe(409);
    expect(users.get('u1')!.totpSecret).toBeNull();
  });

  it('ya activada → 409 (no se puede cambiar por otra desde el login)', async () => {
    const { svc } = makeService([owner({ isSuperAdmin: true, totpSecret: 'JBSWY3DPEHPK3PXP' })]);
    expect(await statusOf(svc.setupAtLogin('u1', SCOPE))).toBe(409);
  });

  it('activarla desde Ajustes en un super-admin también avisa; en quien no lo es, no', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const [isSuperAdmin, sends] of [
      [true, 1],
      [false, 0],
    ] as const) {
      const { svc, telegram, audit } = makeService([owner({ isSuperAdmin })]);
      const { secret } = await svc.setup('u1', PASSWORD, SID);
      await svc.confirm('u1', codeFor(secret), PASSWORD);
      expect(telegram.send).toHaveBeenCalledTimes(sends);
      const logged = audit.log.mock.calls.find((c) => (c[0] as { action: string }).action === 'auth.totp.enabled')![0];
      expect('payload' in (logged as object)).toBe(isSuperAdmin);
    }
  });

  it('con NIGHTPAY_DISABLE_ALERTS=1 (o en pruebas) no manda nada', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NIGHTPAY_DISABLE_ALERTS', '1');
    const { svc, telegram } = makeService([owner({ isSuperAdmin: true })]);
    const { secret } = await svc.setupAtLogin('u1', SCOPE);
    await svc.confirmAtLogin('u1', codeFor(secret), SCOPE);
    expect(telegram.send).not.toHaveBeenCalled();
  });
});
