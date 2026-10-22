import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService, REFRESH_TOKEN_TTL_SECONDS } from '../auth/refresh-token.service';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { SuperAdminGuard } from './superadmin.guard';

const SUB = '00000000-0000-4000-8000-000000000001';
const TENANT = '00000000-0000-4000-8000-000000000002';

async function setup(options: { verified?: boolean; sessionUser?: string } = {}) {
  const redis = createFakeRedis();
  const sessions = new RefreshTokenService(redis as never);
  const issued = await sessions.issue(options.sessionUser ?? SUB, TENANT);
  if (options.verified !== false) await sessions.markTwoFactor(issued.family);
  const user = { id: SUB, email: 'super@x.es', isSuperAdmin: true, deletedAt: null, totpSecret: 'sealed-secret' };
  const tx = { user: { findUnique: vi.fn(async () => user) } };
  const prisma = { acrossVenues: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const guard = new SuperAdminGuard(prisma as never, sessions);
  const req = { user: { sub: SUB, sid: issued.family, tenantId: 'another-venue', role: 'OWNER' }, headers: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  return { guard, ctx, req, user, sessions, issued, redis };
}

describe('SuperAdminGuard: sesión viva y MFA de esa sesión', () => {
  it('permite la sesión verificada aunque tenga otro local activo', async () => {
    const { guard, ctx } = await setup();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rechaza el access token OWNER anterior a la promoción aunque ahora tenga permiso y 2FA', async () => {
    const { guard, ctx } = await setup({ verified: false });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza un access token sin sid', async () => {
    const { guard, ctx, req } = await setup();
    Reflect.deleteProperty(req.user, 'sid');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza sid ajeno aunque la otra sesión tenga MFA', async () => {
    const { guard, ctx } = await setup({ sessionUser: 'another-user' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza inmediatamente tras logout, con el access token aún válido', async () => {
    const { guard, ctx, sessions, issued } = await setup();
    await sessions.revoke(issued.token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza inmediatamente tras revocar todas las sesiones', async () => {
    const { guard, ctx, sessions } = await setup();
    await sessions.revokeAllForUser(SUB);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza una sesión caducada aunque quede una marca MFA en Redis', async () => {
    vi.useFakeTimers();
    try {
      const { guard, ctx } = await setup();
      vi.advanceTimersByTime((REFRESH_TOKEN_TTL_SECONDS + 1) * 1000);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechaza tras restablecer la 2FA aunque conserve sesión y prueba MFA antiguas', async () => {
    const { guard, ctx, user } = await setup();
    Reflect.set(user, 'totpSecret', null);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un corte de Redis falla cerrado', async () => {
    const { guard, ctx, redis, req } = await setup();
    vi.spyOn(redis, 'scan').mockRejectedValue(new Error('Redis unavailable'));
    await expect(guard.canActivate(ctx)).rejects.toThrow('Redis unavailable');
    expect(req).not.toHaveProperty('superAdmin');
  });

  it('refrescar conserva el acceso de la misma sesión verificada', async () => {
    const { guard, ctx, sessions, issued, req } = await setup();
    const rotated = await sessions.rotate(issued.token);
    expect(rotated.family).toBe(req.user.sid);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
