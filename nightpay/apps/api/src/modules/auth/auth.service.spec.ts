import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

interface Overrides {
  findUniqueResult?: unknown;
  signAsyncResult?: string;
  verifyPasswordResult?: boolean;
  isLocked?: { locked: boolean; ttlSeconds: number };
}

function makeService(overrides: Overrides = {}) {
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async (fn) =>
      fn({
        user: {
          findUnique: vi.fn().mockResolvedValue(overrides.findUniqueResult ?? null),
        },
      }),
    ),
  };
  const jwtMock = {
    signAsync: vi.fn().mockResolvedValue(overrides.signAsyncResult ?? 'TOKEN'),
  };
  const lockoutMock = {
    isLocked: vi.fn().mockResolvedValue(overrides.isLocked ?? { locked: false, ttlSeconds: 0 }),
    recordFailure: vi.fn().mockResolvedValue({ count: 1, locked: false }),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const auditMock = {
    log: vi.fn().mockResolvedValue(undefined),
  };
  const metricsMock = {
    authLogins: { inc: vi.fn() },
  };
  const svc = new AuthService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwtMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lockoutMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auditMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metricsMock as any,
  );
  if (overrides.verifyPasswordResult !== undefined) {
    vi.spyOn(svc, 'verifyPassword').mockResolvedValue(overrides.verifyPasswordResult);
  }
  return { svc, prismaMock, jwtMock, lockoutMock, auditMock, metricsMock };
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
    const { svc, lockoutMock } = makeService({ findUniqueResult: null });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(lockoutMock.recordFailure).toHaveBeenCalledOnce();
  });

  it('rejects bad password + records failure', async () => {
    const user = {
      id: 'u1',
      email: 'a@b.test',
      role: 'MANAGER',
      tenantId: 't1',
      passwordHash: '$2a$10$fakehash',
      deletedAt: null,
      venue: { slug: 'luna-vlc' },
    };
    const { svc, lockoutMock } = makeService({ findUniqueResult: user, verifyPasswordResult: false });
    await expect(svc.login({ email: 'a@b.test', password: 'wrong12345' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(lockoutMock.recordFailure).toHaveBeenCalledOnce();
  });

  it('issues token + clears lockout on success', async () => {
    const user = {
      id: 'u1',
      email: 'a@b.test',
      role: 'OWNER',
      tenantId: 't1',
      passwordHash: '$2a$10$fakehash',
      deletedAt: null,
      venue: { slug: 'luna-vlc' },
    };
    const { svc, jwtMock, lockoutMock, auditMock } = makeService({
      findUniqueResult: user,
      verifyPasswordResult: true,
      signAsyncResult: 'JWT.X',
    });
    const result = await svc.login({ email: 'a@b.test', password: 'correct12' });
    expect(result.accessToken).toBe('JWT.X');
    expect(lockoutMock.clear).toHaveBeenCalledOnce();
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login.ok' }));
    expect(jwtMock.signAsync).toHaveBeenCalledOnce();
  });
});
