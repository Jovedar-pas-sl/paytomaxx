import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LockoutService, PER_IP_POLICY } from './lockout.service';
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
}

function makeService(overrides: Overrides = {}) {
  const findMany = vi.fn().mockResolvedValue(overrides.loginCandidates ?? []);
  const tx = {
    user: {
      findMany,
      findUnique: vi.fn().mockResolvedValue(overrides.findUniqueResult ?? null),
    },
  };
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async (fn) => fn(tx)),
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
  };
  const svc = new AuthService(
    prismaMock as never,
    jwtMock as never,
    lockoutMock,
    auditMock as never,
    metricsMock as never,
    refreshTokensMock as never,
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
    const { svc, refreshTokensMock } = makeService({ findUniqueResult: makeUser(), signAsyncResult: 'JWT.R' });
    refreshTokensMock.rotate.mockResolvedValue(rotated());
    const res = await svc.refresh('rt.old');
    expect(res).toMatchObject({ accessToken: 'JWT.R', refreshToken: 'rt.new' });
    expect(refreshTokensMock.revokeFamily).not.toHaveBeenCalled();
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
