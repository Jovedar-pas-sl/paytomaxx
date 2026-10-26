import { describe, it, expect, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AuthGuard } from './auth.guard';
import { AccessRevocationService } from '../../modules/auth/access-revocation.service';
import { createFakeRedis } from '../../modules/auth/testing/fake-redis';

const SID = '11111111-1111-4111-8111-111111111111';
const PAYLOAD = {
  sub: '7d0f4f9e-0000-4000-8000-000000000001',
  email: 'enc@local.es',
  role: 'MANAGER',
  tenantId: '7d0f4f9e-0000-4000-8000-0000000000aa',
  venueSlug: 'luna',
  sid: SID,
  iat: Math.floor(Date.now() / 1000) - 60,
};

function makeGuard(opts: { isPublic?: boolean; verify?: () => Promise<unknown> } = {}) {
  const jwt = { verifyAsync: vi.fn(opts.verify ?? (() => Promise.resolve(PAYLOAD))) };
  const reflector = new Reflector();
  reflector.getAllAndOverride = vi.fn().mockReturnValue(opts.isPublic ?? false);
  const cls = new ClsService(new AsyncLocalStorage());
  const redis = createFakeRedis();
  const revocations = new AccessRevocationService(redis as never);
  return { guard: new AuthGuard(jwt as never, reflector, cls as never, revocations), cls, revocations, redis };
}

/** Como tras el middleware de CLS (el de la app). */
function inRequest<T>(cls: ClsService, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 'trace-1' });
    return fn();
  });
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

describe('AuthGuard — sesión cerrada: el token de acceso deja de valer al momento', () => {
  it('logout o sesión revocada (sid) → 401 SESSION_REVOKED, aunque la firma y la hora valgan', async () => {
    const { guard, cls, revocations } = makeGuard();
    await inRequest(cls, () => expect(guard.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true));
    await revocations.revokeSession(SID);
    const err = await inRequest(cls, () => guard.canActivate(ctx({ authorization: 'Bearer t' }))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('todas las sesiones de la persona revocadas (móvil perdido, baja) → 401', async () => {
    const { guard, cls, revocations } = makeGuard();
    await revocations.revokeUser(PAYLOAD.sub);
    await expect(inRequest(cls, () => guard.canActivate(ctx({ authorization: 'Bearer t' })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('Redis no responde → 503, no 401: la app no echa a nadie y vuelve a probar (fail-closed)', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { guard, cls, redis } = makeGuard();
    vi.spyOn(redis, 'mget').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(inRequest(cls, () => guard.canActivate(ctx({ authorization: 'Bearer t' })))).rejects.toThrow(
      ServiceUnavailableException,
    );
    // Vuelve Redis: el mismo token sigue valiendo.
    await expect(inRequest(cls, () => guard.canActivate(ctx({ authorization: 'Bearer t' })))).resolves.toBe(true);
  });

  it('un token rechazado por la firma ni pregunta a Redis', async () => {
    const invalid = makeGuard({ verify: () => Promise.reject(new Error('invalid signature')) });
    const mget = vi.spyOn(invalid.redis, 'mget');
    await expect(invalid.guard.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toThrow(UnauthorizedException);
    expect(mget).not.toHaveBeenCalled();
  });
});
