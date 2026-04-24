import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

function makeService(overrides: Partial<{
  findUniqueResult: unknown;
  signAsyncResult: string;
  verifyPasswordResult: boolean;
}> = {}) {
  const prismaMock = {
    user: {
      findUnique: vi.fn().mockResolvedValue(overrides.findUniqueResult ?? null),
    },
  };
  const jwtMock = {
    signAsync: vi.fn().mockResolvedValue(overrides.signAsyncResult ?? 'TOKEN'),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new AuthService(prismaMock as any, jwtMock as any);
  if (overrides.verifyPasswordResult !== undefined) {
    vi.spyOn(svc, 'verifyPassword').mockResolvedValue(overrides.verifyPasswordResult);
  }
  return { svc, prismaMock, jwtMock };
}

describe('AuthService.login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown user', async () => {
    const { svc } = makeService({ findUniqueResult: null });
    await expect(svc.login({ email: 'nobody@x.test', password: 'whatever12' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects invalid password', async () => {
    const user = {
      id: 'u1', email: 'a@b.test', role: 'MANAGER', tenantId: 't1',
      passwordHash: '$2a$10$fakehash', deletedAt: null,
      venue: { slug: 'luna-vlc' },
    };
    const { svc } = makeService({ findUniqueResult: user, verifyPasswordResult: false });
    await expect(svc.login({ email: 'a@b.test', password: 'wrong12345' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when venueSlug mismatch', async () => {
    const user = {
      id: 'u1', email: 'a@b.test', role: 'MANAGER', tenantId: 't1',
      passwordHash: '$2a$10$fakehash', deletedAt: null,
      venue: { slug: 'luna-vlc' },
    };
    const { svc } = makeService({ findUniqueResult: user, verifyPasswordResult: true });
    await expect(
      svc.login({ email: 'a@b.test', password: 'correct12', venueSlug: 'luna-mad' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues token for valid credentials', async () => {
    const user = {
      id: 'u1', email: 'a@b.test', role: 'OWNER', tenantId: 't1',
      passwordHash: '$2a$10$fakehash', deletedAt: null,
      venue: { slug: 'luna-vlc' },
    };
    const { svc, jwtMock } = makeService({
      findUniqueResult: user,
      verifyPasswordResult: true,
      signAsyncResult: 'MY.JWT.TOKEN',
    });
    const result = await svc.login({ email: 'a@b.test', password: 'correct12' });
    expect(result.accessToken).toBe('MY.JWT.TOKEN');
    expect(result.user.role).toBe('OWNER');
    expect(result.user.venueSlug).toBe('luna-vlc');
    expect(jwtMock.signAsync).toHaveBeenCalledOnce();
  });
});
