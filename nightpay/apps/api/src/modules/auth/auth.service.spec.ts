import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LockoutService, PER_IP_POLICY } from './lockout.service';
import { LoginTicketService } from './login-ticket.service';
import { passwordFingerprint, RefreshTokenReuseError } from './refresh-token.service';
import { createFakeRedis } from './testing/fake-redis';

interface Overrides {
  /** Lo que devuelve la búsqueda del login (email sin distinguir mayúsculas). */
  loginCandidates?: unknown[];
  findUniqueResult?: unknown;
  signAsyncResult?: string;
  verifyPasswordResult?: boolean;
  /** Claves de bloqueo ya bloqueadas (segundos que quedan). */
  lockedKeys?: Record<string, number>;
  trustedKeys?: string[];
  refreshTokenResult?: { token: string; family: string; ttlSeconds: number };
  /** Locales que encuentra venue.findUnique (cambio de local, refresco). */
  venues?: Record<string, { id: string; slug: string; deletedAt: Date | null }>;
  /** Local elegido en la sesión (refreshTokens.activeVenue). */
  activeVenue?: string | null;
  /** La sesión entró con la 2FA (login en dos pasos). */
  sessionTwoFactor?: boolean;
  /** El usuario tiene la 2FA activada. */
  totpEnabled?: boolean;
  /** Lo que da refreshTokens.liveSession (por defecto, viva y de u1). */
  liveSession?: { userId: string } | null;
}

function makeService(overrides: Overrides = {}) {
  const findMany = vi.fn().mockResolvedValue(overrides.loginCandidates ?? []);
  const tx = {
    user: {
      findMany,
      findUnique: vi.fn().mockResolvedValue(overrides.findUniqueResult ?? null),
    },
    venue: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => overrides.venues?.[where.id] ?? null),
    },
  };
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async (fn) => fn(tx)),
    acrossVenues: vi.fn().mockImplementation(async (fn) => fn(tx)),
  };
  const jwtMock = {
    signAsync: vi.fn().mockResolvedValue(overrides.signAsyncResult ?? 'TOKEN'),
  };
  // El LockoutService de verdad sobre el Redis de mentira (el script Lua emulado).
  const redis = createFakeRedis();
  for (const [key, ttl] of Object.entries(overrides.lockedKeys ?? {})) {
    void redis.set(`nightpay:lockout:locked:${key}`, '1', 'EX', ttl);
  }
  for (const key of overrides.trustedKeys ?? []) void redis.set(`nightpay:lockout:trusted:${key}`, '1', 'EX', 3600);
  const lockoutMock = new LockoutService(redis as never);
  vi.spyOn(lockoutMock, 'clear');
  vi.spyOn(lockoutMock, 'markTrusted');
  const auditMock = {
    log: vi.fn().mockResolvedValue(undefined),
  };
  const metricsMock = {
    authLogins: { inc: vi.fn() },
  };
  const refreshTokensMock = {
    issue: vi.fn().mockResolvedValue(
      overrides.refreshTokenResult ?? { token: 'rt.secret', family: 'fam-1', ttlSeconds: 2592000 },
    ),
    rotate: vi.fn(),
    revoke: vi.fn().mockResolvedValue(null),
    revokeAllForUser: vi.fn().mockResolvedValue(0),
    revokeFamily: vi.fn().mockResolvedValue(undefined),
    stampFingerprint: vi.fn().mockResolvedValue(undefined),
    activeVenue: vi.fn().mockResolvedValue(overrides.activeVenue ?? null),
    setActiveVenue: vi.fn().mockResolvedValue(undefined),
    markTwoFactor: vi.fn().mockResolvedValue(undefined),
    hasTwoFactor: vi.fn().mockResolvedValue(overrides.sessionTwoFactor ?? false),
    liveSession: vi.fn().mockResolvedValue(overrides.liveSession === undefined ? { userId: 'u1' } : overrides.liveSession),
  };
  const totpMock = {
    assertForUser: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockResolvedValue(overrides.totpEnabled ?? false),
  };
  const tickets = new LoginTicketService(redis as never);
  const enrollmentMock = {
    setupAtLogin: vi.fn().mockResolvedValue({ otpauthUrl: 'otpauth://totp/x', secret: 'ABC', qrPngDataUrl: 'data:image/png;base64,x' }),
    confirmAtLogin: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new AuthService(
    prismaMock as never,
    jwtMock as never,
    lockoutMock,
    auditMock as never,
    metricsMock as never,
    refreshTokensMock as never,
    totpMock as never,
    tickets,
    enrollmentMock as never,
  );
  const verifyPassword = vi.spyOn(svc, 'verifyPassword');
  if (overrides.verifyPasswordResult !== undefined) {
    verifyPassword.mockResolvedValue(overrides.verifyPasswordResult);
  }
  return {
    svc,
    prismaMock,
    tx,
    findMany,
    jwtMock,
    lockoutMock,
    redis,
    auditMock,
    metricsMock,
    refreshTokensMock,
    totpMock,
    tickets,
    enrollmentMock,
    verifyPassword,
  };
}

/** Fallos contados en Redis para una clave de bloqueo (null = ninguno). */
async function failCount(redis: ReturnType<typeof createFakeRedis>, key: string): Promise<string | null> {
  return redis.get(`nightpay:lockout:fail:${key}`);
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@b.test',
    role: 'OWNER',
    tenantId: 't1',
    passwordHash: '$2a$10$fakehash',
    deletedAt: null,
    isSuperAdmin: false,
    venue: { slug: 'luna-vlc' },
    ...overrides,
  };
}

describe('AuthService.login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when account is locked', async () => {
    const { svc, verifyPassword } = makeService({ lockedKeys: { 'x@y.test|-': 600 } });
    await expect(svc.login({ email: 'x@y.test', password: 'pwd12345' })).rejects.toThrow(
      UnauthorizedException,
    );
    // Bloqueado: ni se mira la contraseña.
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('rejects unknown user + records failure', async () => {
    const { svc, redis } = makeService({ loginCandidates: [], verifyPasswordResult: false });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
    // Por IP (5 fallos) y por cuenta (30 fallos, cualquier IP).
    expect(await failCount(redis, 'nobody@x.test|-')).toBe('1');
    expect(await failCount(redis, 'cuenta:nobody@x.test')).toBe('1');
  });

  it('el intento se cuenta ANTES de bcrypt: 20 a la vez no prueban más de 5 contraseñas', async () => {
    const { svc, verifyPassword, auditMock } = makeService({ loginCandidates: [makeUser()] });
    verifyPassword.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return false;
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => svc.login({ email: 'a@b.test', password: 'adivinanza1' }, '198.51.100.9')),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(verifyPassword).toHaveBeenCalledTimes(PER_IP_POLICY.threshold);
    const locked = auditMock.log.mock.calls.filter(([e]) => e.action === 'auth.login.locked');
    expect(locked).toHaveLength(20 - PER_IP_POLICY.threshold);
    const failed = auditMock.log.mock.calls.filter(([e]) => e.action === 'auth.login.failed').map(([e]) => e.payload);
    expect(failed.map((p) => p.count).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(failed.find((p) => p.count === PER_IP_POLICY.threshold)).toMatchObject({ locked: true });
  });

  it('con 4 fallos, el quinto intento con la contraseña buena entra y borra el bloqueo', async () => {
    const { svc, verifyPassword, redis } = makeService({ loginCandidates: [makeUser()] });
    verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 4; i++) {
      await expect(svc.login({ email: 'a@b.test', password: 'mala-12345' }, '198.51.100.9')).rejects.toThrow();
    }
    verifyPassword.mockResolvedValue(true);
    await expect(svc.login({ email: 'a@b.test', password: 'buena-1234' }, '198.51.100.9')).resolves.toMatchObject({
      accessToken: 'TOKEN',
    });
    expect(redis.keys().filter((k) => k.startsWith('nightpay:lockout:locked:'))).toEqual([]);
  });

  it('usuario desconocido: compara igualmente con bcrypt (mismo tiempo que una contraseña mala)', async () => {
    const { svc, verifyPassword } = makeService({ loginCandidates: [] });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyPassword).toHaveBeenCalledWith('whatever12', expect.stringMatching(/^\$2[ab]\$10\$.{53}$/));
  });

  it('rejects bad password + records failure', async () => {
    const { svc, redis } = makeService({ loginCandidates: [makeUser()], verifyPasswordResult: false });
    await expect(svc.login({ email: 'a@b.test', password: 'wrong12345' })).rejects.toThrow(
      UnauthorizedException,
    );
    // Por IP (5 fallos) y por cuenta (30 fallos, cualquier IP).
    expect(await failCount(redis, 'a@b.test|-')).toBe('1');
    expect(await failCount(redis, 'cuenta:a@b.test')).toBe('1');
  });

  it('busca el email sin distinguir mayúsculas (usuarios antiguos con mayúsculas)', async () => {
    const user = makeUser({ email: 'Dueno@Local.es' });
    const { svc, findMany } = makeService({ loginCandidates: [user], verifyPasswordResult: true });
    const result = await svc.login({ email: 'dueno@local.es', password: 'correct12' });
    expect(result.user.id).toBe('u1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'dueno@local.es', mode: 'insensitive' }, deletedAt: null },
      }),
    );
  });

  it('si hay varias variantes de mayúsculas, gana la exacta', async () => {
    const exact = makeUser({ id: 'u-exact', email: 'Ana@x.es' });
    const other = makeUser({ id: 'u-other', email: 'ana@x.es' });
    const { svc } = makeService({ loginCandidates: [other, exact], verifyPasswordResult: true });
    const result = await svc.login({ email: 'Ana@x.es', password: 'correct12' });
    expect(result.user.id).toBe('u-exact');
  });

  it('varias variantes y ninguna exacta → como desconocido (no adivinamos la cuenta)', async () => {
    const a = makeUser({ id: 'u-a', email: 'ANA@x.es' });
    const b = makeUser({ id: 'u-b', email: 'ana@x.es' });
    const { svc } = makeService({ loginCandidates: [a, b], verifyPasswordResult: true });
    await expect(svc.login({ email: 'Ana@x.es', password: 'correct12' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('descarta coincidencias que no son el mismo email (comodines de ILIKE)', async () => {
    const lookalike = makeUser({ email: 'joneXdoe@x.es' });
    const { svc } = makeService({ loginCandidates: [lookalike], verifyPasswordResult: true });
    await expect(svc.login({ email: 'jone_doe@x.es', password: 'correct12' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('bloqueo de la cuenta: desde una IP desconocida no deja entrar', async () => {
    const { svc } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
      lockedKeys: { 'cuenta:a@b.test': 200 },
    });
    await expect(svc.login({ email: 'a@b.test', password: 'correct12' }, '198.51.100.9')).rejects.toThrow(
      /Demasiados intentos/,
    );
  });

  it('bloqueo de la cuenta: desde una IP donde ya entró bien, el dueño sí entra', async () => {
    const { svc } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
      lockedKeys: { 'cuenta:a@b.test': 200 },
      trustedKeys: ['a@b.test|203.0.113.7'],
    });
    const result = await svc.login({ email: 'a@b.test', password: 'correct12' }, '203.0.113.7');
    expect(result.accessToken).toBe('TOKEN');
  });

  it('cuenta bloqueada desde una IP desconocida: no gasta intentos de esa IP', async () => {
    const { svc, redis } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
      lockedKeys: { 'cuenta:a@b.test': 200 },
    });
    await expect(svc.login({ email: 'a@b.test', password: 'correct12' }, '198.51.100.9')).rejects.toThrow();
    expect(await failCount(redis, 'a@b.test|198.51.100.9')).toBeNull();
  });

  it('el bloqueo por IP manda aunque la IP sea de confianza', async () => {
    const { svc } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
      lockedKeys: { 'a@b.test|203.0.113.7': 600 },
      trustedKeys: ['a@b.test|203.0.113.7'],
    });
    await expect(svc.login({ email: 'a@b.test', password: 'correct12' }, '203.0.113.7')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('el email del atacante se recorta a 254 en el registro de fallos', async () => {
    const huge = `${'a'.repeat(600)}@x.es`;
    const { svc, auditMock } = makeService({ loginCandidates: [], verifyPasswordResult: false });
    await expect(svc.login({ email: huge, password: 'whatever12' })).rejects.toThrow(UnauthorizedException);
    const failed = auditMock.log.mock.calls.find(([e]) => e.action === 'auth.login.failed')![0];
    expect(failed.actorEmail).toHaveLength(254);
  });

  it('issues token + clears lockout on success', async () => {
    const { svc, jwtMock, lockoutMock, auditMock } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
      signAsyncResult: 'JWT.X',
    });
    const result = await svc.login({ email: 'a@b.test', password: 'correct12' });
    expect(result.accessToken).toBe('JWT.X');
    expect(result.refreshToken).toBe('rt.secret');
    expect(result.refreshExpiresIn).toBeGreaterThan(0);
    expect(lockoutMock.clear).toHaveBeenCalledTimes(2);
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login.ok' }));
    expect(jwtMock.signAsync).toHaveBeenCalledOnce();
  });

  it('login correcto: la pareja email|IP queda como de confianza', async () => {
    const { svc, lockoutMock } = makeService({ loginCandidates: [makeUser()], verifyPasswordResult: true });
    await svc.login({ email: 'A@B.test', password: 'correct12' }, '2001:db8:1:2::99');
    expect(lockoutMock.markTrusted).toHaveBeenCalledWith('a@b.test|2001:db8:1:2::/64');
  });

  it('issues refresh token on successful login', async () => {
    const { svc, refreshTokensMock } = makeService({
      loginCandidates: [makeUser()],
      verifyPasswordResult: true,
    });
    await svc.login({ email: 'a@b.test', password: 'correct12' });
    expect(refreshTokensMock.issue).toHaveBeenCalledWith('u1', 't1', {
      pwdFp: passwordFingerprint('$2a$10$fakehash'),
    });
  });

  it('el access token lleva la sesión (sid = family del refresh)', async () => {
    const { svc, jwtMock } = makeService({ loginCandidates: [makeUser()], verifyPasswordResult: true });
    await svc.login({ email: 'a@b.test', password: 'correct12' });
    expect(jwtMock.signAsync.mock.calls[0]![0]).toMatchObject({ sub: 'u1', tenantId: 't1', sid: 'fam-1' });
  });
});

describe('AuthService.refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  const rotated = (overrides: Record<string, unknown> = {}) => ({
    userId: 'u1',
    tenantId: 't1',
    family: 'fam-1',
    pwdFp: passwordFingerprint('$2a$10$fakehash'),
    token: 'rt.new',
    ttlSeconds: 2592000,
    ...overrides,
  });

  it('misma contraseña → access token nuevo y refresh rotado', async () => {
    const { svc, refreshTokensMock, jwtMock } = makeService({ findUniqueResult: makeUser(), signAsyncResult: 'JWT.R' });
    refreshTokensMock.rotate.mockResolvedValue(rotated());
    const res = await svc.refresh('rt.old');
    expect(res).toMatchObject({ accessToken: 'JWT.R', refreshToken: 'rt.new' });
    expect(refreshTokensMock.revokeFamily).not.toHaveBeenCalled();
    expect(jwtMock.signAsync.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', venueSlug: 'luna-vlc', sid: 'fam-1' });
  });

  it('super-admin con otro local elegido en la sesión → el token sale ya para ese local', async () => {
    const { svc, refreshTokensMock, jwtMock } = makeService({
      findUniqueResult: makeUser({ isSuperAdmin: true }),
      activeVenue: 't9',
      venues: { t9: { id: 't9', slug: 'mar', deletedAt: null } },
      sessionTwoFactor: true,
      totpEnabled: true,
    });
    refreshTokensMock.rotate.mockResolvedValue(rotated());
    await svc.refresh('rt.old');
    expect(refreshTokensMock.activeVenue).toHaveBeenCalledWith('fam-1');
    expect(jwtMock.signAsync.mock.calls[0]![0]).toMatchObject({ tenantId: 't9', venueSlug: 'mar', role: 'OWNER' });
  });

  it('ya no es super-admin (o el local se borró) → su local y se olvida el elegido', async () => {
    for (const setup of [
      { user: makeUser({ isSuperAdmin: false }), venues: { t9: { id: 't9', slug: 'mar', deletedAt: null } } },
      { user: makeUser({ isSuperAdmin: true }), venues: { t9: { id: 't9', slug: 'mar', deletedAt: new Date() } } },
    ]) {
      const { svc, refreshTokensMock, jwtMock } = makeService({
        findUniqueResult: setup.user,
        activeVenue: 't9',
        venues: setup.venues,
        sessionTwoFactor: true,
        totpEnabled: true,
      });
      refreshTokensMock.rotate.mockResolvedValue(rotated());
      await svc.refresh('rt.old');
      expect(jwtMock.signAsync.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', venueSlug: 'luna-vlc' });
      expect(refreshTokensMock.setActiveVenue).toHaveBeenCalledWith('fam-1', null);
    }
  });

  it('super-admin cuya sesión no entró con la 2FA (o que la quitó) → revoca la sesión y 401', async () => {
    for (const setup of [
      { sessionTwoFactor: false, totpEnabled: true },
      { sessionTwoFactor: true, totpEnabled: false },
    ]) {
      const { svc, refreshTokensMock, auditMock, jwtMock } = makeService({
        findUniqueResult: makeUser({ isSuperAdmin: true }),
        ...setup,
      });
      refreshTokensMock.rotate.mockResolvedValue(rotated());
      await expect(svc.refresh('rt.old')).rejects.toThrow(/código de verificación/);
      expect(refreshTokensMock.revokeFamily).toHaveBeenCalledWith('fam-1');
      expect(jwtMock.signAsync).not.toHaveBeenCalled();
      expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.refresh.two_factor_required' }));
    }
  });

  it('la contraseña cambió desde el login → revoca la sesión entera y 401', async () => {
    const { svc, refreshTokensMock, auditMock } = makeService({
      findUniqueResult: makeUser({ passwordHash: '$2a$10$nuevaContrasena' }),
    });
    refreshTokensMock.rotate.mockResolvedValue(rotated());
    await expect(svc.refresh('rt.old')).rejects.toThrow(/contraseña ha cambiado/);
    expect(refreshTokensMock.revokeFamily).toHaveBeenCalledWith('fam-1');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh.password_changed', actorId: 'u1' }),
    );
  });

  it('token de antes de esta versión (sin huella) → vale y se le apunta la huella actual', async () => {
    const { svc, refreshTokensMock } = makeService({ findUniqueResult: makeUser() });
    refreshTokensMock.rotate.mockResolvedValue(rotated({ pwdFp: undefined }));
    await expect(svc.refresh('rt.old')).resolves.toMatchObject({ refreshToken: 'rt.new' });
    expect(refreshTokensMock.stampFingerprint).toHaveBeenCalledWith('rt.new', passwordFingerprint('$2a$10$fakehash'));
  });

  it('usuario dado de baja → revoca todo lo suyo y 401', async () => {
    const { svc, refreshTokensMock } = makeService({ findUniqueResult: makeUser({ deletedAt: new Date() }) });
    refreshTokensMock.rotate.mockResolvedValue(rotated());
    await expect(svc.refresh('rt.old')).rejects.toThrow(UnauthorizedException);
    expect(refreshTokensMock.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('reuso de un token ya usado → queda en el audit y 401', async () => {
    const { svc, refreshTokensMock, auditMock } = makeService({ findUniqueResult: makeUser() });
    refreshTokensMock.rotate.mockRejectedValue(
      new RefreshTokenReuseError({ userId: 'u1', tenantId: 't1', family: 'fam-1' }),
    );
    await expect(svc.refresh('rt.old', '1.2.3.4')).rejects.toThrow(UnauthorizedException);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh.reuse_detected', actorId: 'u1', ip: '1.2.3.4' }),
    );
  });
});

describe('AuthService.switchTenant', () => {
  beforeEach(() => vi.clearAllMocks());

  /** `exp` de un access token recién emitido (s). */
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  const superAdmin = () => ({ ...makeUser({ isSuperAdmin: true }), tenantId: 't1' });
  const venues = { t1: { id: 't1', slug: 'luna-vlc', deletedAt: null }, t9: { id: 't9', slug: 'mar', deletedAt: null } };

  it('sesión de antes del login en dos pasos: a otro local pide el código 2FA y la sesión recuerda el local', async () => {
    const { svc, totpMock, refreshTokensMock, jwtMock, auditMock } = makeService({ findUniqueResult: superAdmin(), venues });
    const res = await svc.switchTenant('u1', 't9', { totpCode: '123456', sessionId: 'fam-1', tokenExp: inAnHour() });
    expect(res).toMatchObject({ tenantId: 't9', venueSlug: 'mar' });
    expect(totpMock.assertForUser).toHaveBeenCalledWith('u1', '123456');
    expect(refreshTokensMock.setActiveVenue).toHaveBeenCalledWith('fam-1', 't9');
    expect(jwtMock.signAsync.mock.calls[0]![0]).toMatchObject({ tenantId: 't9', sid: 'fam-1' });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.switch_tenant', payload: expect.objectContaining({ twoFactor: 'code' }) }),
    );
  });

  it('la sesión entró con la 2FA: cambiar de local no vuelve a pedir el código', async () => {
    const { svc, totpMock, refreshTokensMock, auditMock } = makeService({
      findUniqueResult: superAdmin(),
      venues,
      sessionTwoFactor: true,
      totpEnabled: true,
    });
    await expect(svc.switchTenant('u1', 't9', { sessionId: 'fam-1', tokenExp: inAnHour() })).resolves.toMatchObject({ tenantId: 't9' });
    expect(refreshTokensMock.hasTwoFactor).toHaveBeenCalledWith('fam-1');
    expect(totpMock.assertForUser).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.switch_tenant', payload: expect.objectContaining({ twoFactor: 'login' }) }),
    );
  });

  it('entró con la 2FA pero la ha desactivado después: vuelve a pedir el código (y sin 2FA, no se puede)', async () => {
    const { svc, totpMock } = makeService({ findUniqueResult: superAdmin(), venues, sessionTwoFactor: true, totpEnabled: false });
    totpMock.assertForUser.mockRejectedValue(new ForbiddenException({ code: 'TOTP_NOT_ENROLLED' }));
    await expect(svc.switchTenant('u1', 't9', { sessionId: 'fam-1', tokenExp: inAnHour() })).rejects.toBeInstanceOf(ForbiddenException);
    expect(totpMock.assertForUser).toHaveBeenCalledWith('u1', undefined);
  });

  it('sin código (o malo) → el error 2FA y ningún token', async () => {
    const { svc, totpMock, jwtMock, refreshTokensMock } = makeService({ findUniqueResult: superAdmin(), venues });
    totpMock.assertForUser.mockRejectedValue(new ForbiddenException({ code: 'TOTP_REQUIRED' }));
    await expect(svc.switchTenant('u1', 't9', { sessionId: 'fam-1', tokenExp: inAnHour() })).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtMock.signAsync).not.toHaveBeenCalled();
    expect(refreshTokensMock.setActiveVenue).not.toHaveBeenCalled();
  });

  it('volver a su local no pide código y la sesión olvida el elegido', async () => {
    const { svc, totpMock, refreshTokensMock } = makeService({ findUniqueResult: superAdmin(), venues });
    await expect(svc.switchTenant('u1', 't1', { sessionId: 'fam-1', tokenExp: inAnHour() })).resolves.toMatchObject({ tenantId: 't1' });
    expect(totpMock.assertForUser).not.toHaveBeenCalled();
    expect(refreshTokensMock.setActiveVenue).toHaveBeenCalledWith('fam-1', null);
  });

  it('sin sid, con la sesión cerrada (logout, revocada, 90 días) o de otro usuario → 401 y ningún token', async () => {
    for (const setup of [
      { liveSession: { userId: 'u1' }, opts: { tokenExp: inAnHour() } },
      { liveSession: null, opts: { sessionId: 'fam-1', tokenExp: inAnHour() } },
      { liveSession: { userId: 'otro' }, opts: { sessionId: 'fam-1', tokenExp: inAnHour() } },
    ]) {
      const { svc, jwtMock, totpMock, refreshTokensMock } = makeService({
        findUniqueResult: superAdmin(),
        venues,
        sessionTwoFactor: true,
        totpEnabled: true,
        liveSession: setup.liveSession,
      });
      await expect(svc.switchTenant('u1', 't1', setup.opts)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwtMock.signAsync).not.toHaveBeenCalled();
      expect(totpMock.assertForUser).not.toHaveBeenCalled();
      expect(refreshTokensMock.setActiveVenue).not.toHaveBeenCalled();
    }
  });

  it('el token nuevo no dura más que el de entrada (y uno caducado o sin exp → 401)', async () => {
    const { svc, jwtMock, refreshTokensMock } = makeService({ findUniqueResult: superAdmin(), venues });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const res = await svc.switchTenant('u1', 't1', { sessionId: 'fam-1', tokenExp: exp });
    expect(refreshTokensMock.liveSession).toHaveBeenCalledWith('fam-1');
    expect(res.expiresIn).toBeGreaterThan(590);
    expect(res.expiresIn).toBeLessThanOrEqual(600);
    expect(jwtMock.signAsync.mock.calls[0]![1]).toEqual({ expiresIn: res.expiresIn });
    for (const tokenExp of [undefined, Math.floor(Date.now() / 1000) - 1]) {
      await expect(svc.switchTenant('u1', 't1', { sessionId: 'fam-1', tokenExp })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('quien no es super-admin → 403 sin gastar intentos de 2FA', async () => {
    const { svc, totpMock } = makeService({ findUniqueResult: makeUser(), venues });
    await expect(svc.switchTenant('u1', 't9', { totpCode: '123456' })).rejects.toThrow(/super admins/);
    expect(totpMock.assertForUser).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('con solo el refresh token: lo revoca y lo apunta a nombre de su dueño', async () => {
    const { svc, refreshTokensMock, auditMock } = makeService();
    refreshTokensMock.revoke.mockResolvedValue({ userId: 'u1', tenantId: 't1' });
    await svc.logout('rt.x', '1.2.3.4', 'UA');
    expect(refreshTokensMock.revoke).toHaveBeenCalledWith('rt.x');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', actorId: 'u1', tenantId: 't1', ip: '1.2.3.4' }),
    );
  });

  it('token desconocido → no falla ni apunta nada', async () => {
    const { svc, auditMock } = makeService();
    await expect(svc.logout('rt.x')).resolves.toBeUndefined();
    expect(auditMock.log).not.toHaveBeenCalled();
  });
});

describe('AuthService.login — super-admin con 2FA en dos pasos', () => {
  beforeEach(() => vi.clearAllMocks());

  const superAdmin = () => makeUser({ isSuperAdmin: true });

  async function ticketFrom(promise: Promise<unknown>): Promise<string> {
    const err = (await promise.then(
      () => null,
      (e: unknown) => e,
    )) as UnauthorizedException | null;
    expect(err).toBeInstanceOf(UnauthorizedException);
    const body = err!.getResponse() as { code: string; loginTicket: string; expiresIn: number };
    expect(body).toMatchObject({ code: 'TOTP_REQUIRED', expiresIn: 300 });
    return body.loginTicket;
  }

  it('la contraseña sola no abre la sesión: 401 TOTP_REQUIRED con un ticket, sin tokens', async () => {
    const { svc, refreshTokensMock, jwtMock, auditMock } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
      totpEnabled: true,
    });
    const ticket = await ticketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshTokensMock.issue).not.toHaveBeenCalled();
    expect(jwtMock.signAsync).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login.totp_required' }));
  });

  it('con el ticket y un código bueno: sesión abierta y marcada con la 2FA; el ticket no vale dos veces', async () => {
    const { svc, refreshTokensMock, totpMock, tx } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
      totpEnabled: true,
    });
    const ticket = await ticketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    tx.user.findUnique.mockResolvedValue(superAdmin());
    const res = await svc.loginWithTotp(ticket, '123456');
    expect(res).toMatchObject({ accessToken: 'TOKEN', refreshToken: 'rt.secret', user: { isSuperAdmin: true } });
    expect(totpMock.assertForUser).toHaveBeenCalledWith('u1', '123456');
    expect(refreshTokensMock.markTwoFactor).toHaveBeenCalledWith('fam-1');
    await expect(svc.loginWithTotp(ticket, '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
  });

  it('código malo: el error 2FA y el ticket sigue valiendo para otro intento', async () => {
    const { svc, totpMock, tx, refreshTokensMock } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
      totpEnabled: true,
    });
    const ticket = await ticketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    tx.user.findUnique.mockResolvedValue(superAdmin());
    totpMock.assertForUser.mockRejectedValueOnce(new ForbiddenException({ code: 'TOTP_INVALID' }));
    await expect(svc.loginWithTotp(ticket, '000000')).rejects.toBeInstanceOf(ForbiddenException);
    expect(refreshTokensMock.issue).not.toHaveBeenCalled();
    await expect(svc.loginWithTotp(ticket, '123456')).resolves.toMatchObject({ accessToken: 'TOKEN' });
  });

  it('ticket inventado, o la contraseña cambió entre los dos pasos → 401 LOGIN_TICKET_EXPIRED', async () => {
    const { svc, tx } = makeService({ loginCandidates: [superAdmin()], verifyPasswordResult: true, totpEnabled: true });
    await expect(svc.loginWithTotp('x'.repeat(43), '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
    const ticket = await ticketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    tx.user.findUnique.mockResolvedValue(makeUser({ isSuperAdmin: true, passwordHash: '$2a$10$otrohash' }));
    await expect(svc.loginWithTotp(ticket, '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
  });

  it('el ticket del código no sirve para activar la 2FA (y al revés)', async () => {
    const withTotp = makeService({ loginCandidates: [superAdmin()], verifyPasswordResult: true, totpEnabled: true });
    const codeTicket = await ticketFrom(withTotp.svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    withTotp.tx.user.findUnique.mockResolvedValue(superAdmin());
    await expect(withTotp.svc.loginWithNewTotp(codeTicket, '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
    expect(withTotp.enrollmentMock.confirmAtLogin).not.toHaveBeenCalled();

    const noTotp = makeService({ loginCandidates: [superAdmin()], verifyPasswordResult: true });
    const enrollTicket = await setupTicketFrom(noTotp.svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    noTotp.tx.user.findUnique.mockResolvedValue(superAdmin());
    await expect(noTotp.svc.loginWithTotp(enrollTicket, '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
    expect(noTotp.totpMock.assertForUser).not.toHaveBeenCalled();
  });

  it('quien no es super-admin entra como siempre (sin marca de 2FA ni ticket)', async () => {
    const owner = makeService({ loginCandidates: [makeUser()], verifyPasswordResult: true, totpEnabled: true });
    await expect(owner.svc.login({ email: 'a@b.test', password: 'pwd12345' })).resolves.toMatchObject({ accessToken: 'TOKEN' });
    expect(owner.totpMock.isEnabled).not.toHaveBeenCalled();
  });
});

describe('AuthService.login — super-admin sin 2FA (obligatoria)', () => {
  beforeEach(() => vi.clearAllMocks());

  const superAdmin = () => makeUser({ isSuperAdmin: true });

  it('la contraseña sola no abre la sesión: 401 TOTP_SETUP_REQUIRED con un ticket de 10 min, sin tokens', async () => {
    const { svc, refreshTokensMock, jwtMock, auditMock } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
    });
    const ticket = await setupTicketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshTokensMock.issue).not.toHaveBeenCalled();
    expect(jwtMock.signAsync).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login.totp_setup_required' }));
  });

  it('con el ticket: el QR (atado a ese ticket) y, con un código bueno, la sesión marcada con la 2FA', async () => {
    const { svc, tx, enrollmentMock, refreshTokensMock } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
    });
    const ticket = await setupTicketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    tx.user.findUnique.mockResolvedValue(superAdmin());

    await expect(svc.loginTotpSetup(ticket)).resolves.toMatchObject({ secret: 'ABC' });
    const scope = enrollmentMock.setupAtLogin.mock.calls[0]![1] as string;
    expect(enrollmentMock.setupAtLogin).toHaveBeenCalledWith('u1', expect.stringMatching(/^login:[0-9a-f]{32}$/));
    expect(scope).not.toContain(ticket);

    const res = await svc.loginWithNewTotp(ticket, '123456', '1.2.3.4');
    expect(enrollmentMock.confirmAtLogin).toHaveBeenCalledWith('u1', '123456', scope, { ip: '1.2.3.4', userAgent: undefined });
    expect(res).toMatchObject({ accessToken: 'TOKEN', user: { isSuperAdmin: true } });
    expect(refreshTokensMock.markTwoFactor).toHaveBeenCalledWith('fam-1');
    // Un solo uso.
    await expect(svc.loginWithNewTotp(ticket, '123456')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
    });
  });

  it('código malo al activarla: el error y el ticket sigue valiendo', async () => {
    const { svc, tx, enrollmentMock, refreshTokensMock } = makeService({
      loginCandidates: [superAdmin()],
      verifyPasswordResult: true,
    });
    const ticket = await setupTicketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
    tx.user.findUnique.mockResolvedValue(superAdmin());
    enrollmentMock.confirmAtLogin.mockRejectedValueOnce(new ForbiddenException({ code: 'TOTP_INVALID' }));
    await expect(svc.loginWithNewTotp(ticket, '000000')).rejects.toBeInstanceOf(ForbiddenException);
    expect(refreshTokensMock.issue).not.toHaveBeenCalled();
    await expect(svc.loginWithNewTotp(ticket, '123456')).resolves.toMatchObject({ accessToken: 'TOKEN' });
  });

  it('la contraseña cambió o ya no es super-admin entre los dos pasos → LOGIN_TICKET_EXPIRED y sin QR', async () => {
    for (const later of [
      makeUser({ isSuperAdmin: true, passwordHash: '$2a$10$otrohash' }),
      makeUser({ isSuperAdmin: false }),
    ]) {
      const { svc, tx, enrollmentMock } = makeService({ loginCandidates: [superAdmin()], verifyPasswordResult: true });
      const ticket = await setupTicketFrom(svc.login({ email: 'a@b.test', password: 'pwd12345' }));
      tx.user.findUnique.mockResolvedValue(later);
      await expect(svc.loginTotpSetup(ticket)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LOGIN_TICKET_EXPIRED' }),
      });
      expect(enrollmentMock.setupAtLogin).not.toHaveBeenCalled();
    }
  });
});

async function setupTicketFrom(promise: Promise<unknown>): Promise<string> {
  const err = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as UnauthorizedException | null;
  expect(err).toBeInstanceOf(UnauthorizedException);
  const body = err!.getResponse() as { code: string; loginTicket: string; expiresIn: number; message: string };
  expect(body).toMatchObject({ code: 'TOTP_SETUP_REQUIRED', expiresIn: 600 });
  expect(body.message).toMatch(/obligatoria/);
  return body.loginTicket;
}
