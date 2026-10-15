import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ACCOUNT_POLICY } from './lockout.service';

interface Overrides {
  /** Lo que devuelve la búsqueda del login (email sin distinguir mayúsculas). */
  loginCandidates?: unknown[];
  findUniqueResult?: unknown;
  signAsyncResult?: string;
  verifyPasswordResult?: boolean;
  isLocked?: { locked: boolean; ttlSeconds: number };
  /** Bloqueo por clave (gana a isLocked). */
  lockedKeys?: Record<string, number>;
  trustedKeys?: string[];
  refreshTokenResult?: { token: string; family: string; ttlSeconds: number };
}

function makeService(overrides: Overrides = {}) {
  const findMany = vi.fn().mockResolvedValue(overrides.loginCandidates ?? []);
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async (fn) =>
      fn({
        user: {
          findMany,
          findUnique: vi.fn().mockResolvedValue(overrides.findUniqueResult ?? null),
        },
      }),
    ),
  };
  const jwtMock = {
    signAsync: vi.fn().mockResolvedValue(overrides.signAsyncResult ?? 'TOKEN'),
  };
  const isLocked = vi.fn().mockImplementation(async (key: string) => {
    const ttl = overrides.lockedKeys?.[key];
    if (ttl !== undefined) return { locked: true, ttlSeconds: ttl };
    return overrides.isLocked ?? { locked: false, ttlSeconds: 0 };
  });
  const lockoutMock = {
    isLocked,
    recordFailure: vi.fn().mockResolvedValue({ count: 1, locked: false }),
    clear: vi.fn().mockResolvedValue(undefined),
    markTrusted: vi.fn().mockResolvedValue(undefined),
    isTrusted: vi.fn().mockImplementation(async (key: string) => (overrides.trustedKeys ?? []).includes(key)),
  };
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
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn().mockResolvedValue(0),
  };
  const svc = new AuthService(
    prismaMock as never,
    jwtMock as never,
    lockoutMock as never,
    auditMock as never,
    metricsMock as never,
    refreshTokensMock as never,
  );
  const verifyPassword = vi.spyOn(svc, 'verifyPassword');
  if (overrides.verifyPasswordResult !== undefined) {
    verifyPassword.mockResolvedValue(overrides.verifyPasswordResult);
  }
  return { svc, prismaMock, findMany, jwtMock, lockoutMock, auditMock, metricsMock, refreshTokensMock, verifyPassword };
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
    const { svc } = makeService({ isLocked: { locked: true, ttlSeconds: 600 } });
    await expect(svc.login({ email: 'x@y.test', password: 'pwd12345' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects unknown user + records failure', async () => {
    const { svc, lockoutMock } = makeService({ loginCandidates: [], verifyPasswordResult: false });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
    // Por IP (5 fallos) y por cuenta (30 fallos, cualquier IP).
    expect(lockoutMock.recordFailure).toHaveBeenCalledTimes(2);
    expect(lockoutMock.recordFailure.mock.calls[1]![0]).toMatch(/^cuenta:/);
    expect(lockoutMock.recordFailure.mock.calls[1]![1]).toBe(ACCOUNT_POLICY);
  });

  it('usuario desconocido: compara igualmente con bcrypt (mismo tiempo que una contraseña mala)', async () => {
    const { svc, verifyPassword } = makeService({ loginCandidates: [] });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyPassword).toHaveBeenCalledWith('whatever12', expect.stringMatching(/^\$2[ab]\$10\$.{53}$/));
  });

  it('rejects bad password + records failure', async () => {
    const { svc, lockoutMock } = makeService({ loginCandidates: [makeUser()], verifyPasswordResult: false });
    await expect(svc.login({ email: 'a@b.test', password: 'wrong12345' })).rejects.toThrow(
      UnauthorizedException,
    );
    // Por IP (5 fallos) y por cuenta (30 fallos, cualquier IP).
    expect(lockoutMock.recordFailure).toHaveBeenCalledTimes(2);
    expect(lockoutMock.recordFailure.mock.calls[1]![0]).toMatch(/^cuenta:/);
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
    expect(refreshTokensMock.issue).toHaveBeenCalledWith('u1', 't1');
  });
});
