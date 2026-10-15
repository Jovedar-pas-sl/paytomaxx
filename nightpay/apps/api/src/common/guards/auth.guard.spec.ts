import { describe, it, expect, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { InternalServerErrorException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AuthGuard } from './auth.guard';

const PAYLOAD = {
  sub: '7d0f4f9e-0000-4000-8000-000000000001',
  email: 'enc@local.es',
  role: 'MANAGER',
  tenantId: '7d0f4f9e-0000-4000-8000-0000000000aa',
  venueSlug: 'luna',
};

function makeGuard(opts: { isPublic?: boolean; verify?: () => Promise<unknown> } = {}) {
  const jwt = { verifyAsync: vi.fn(opts.verify ?? (() => Promise.resolve(PAYLOAD))) };
  const reflector = new Reflector();
  reflector.getAllAndOverride = vi.fn().mockReturnValue(opts.isPublic ?? false);
  const cls = new ClsService(new AsyncLocalStorage());
  return { guard: new AuthGuard(jwt as never, reflector, cls as never), cls };
}

function ctx(headers: Record<string, string>): ExecutionContext {
  const req = { headers };
  return {
    getHandler: () => () => undefined,
    getClass: () => class X {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('rutas públicas pasan sin sesión', async () => {
    const { guard } = makeGuard({ isPublic: true });
    await expect(guard.canActivate(ctx({}))).resolves.toBe(true);
  });

  it('sin contexto CLS (el middleware no corrió) se rechaza: no se consulta sin filtro por local', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toThrow(InternalServerErrorException);
  });

  it('con contexto: pone el local y conserva el traceId del middleware', async () => {
    const { guard, cls } = makeGuard();
    await cls.run(async () => {
      cls.set('ctx', { traceId: 'trace-1' });
      await expect(guard.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
      expect(cls.get('ctx')).toEqual({
        traceId: 'trace-1',
        tenantId: PAYLOAD.tenantId,
        userId: PAYLOAD.sub,
        role: 'MANAGER',
        venueSlug: 'luna',
      });
    });
  });

  it('sin token, token inválido o token de un solo uso (invitación) → 401', async () => {
    await expect(makeGuard().guard.canActivate(ctx({}))).rejects.toThrow(UnauthorizedException);
    const invalid = makeGuard({ verify: () => Promise.reject(new Error('jwt expired')) });
    await expect(invalid.guard.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toThrow(UnauthorizedException);
    const invite = makeGuard({ verify: () => Promise.resolve({ ...PAYLOAD, purpose: 'operator-invite' }) });
    await expect(invite.guard.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toThrow(UnauthorizedException);
  });
});
