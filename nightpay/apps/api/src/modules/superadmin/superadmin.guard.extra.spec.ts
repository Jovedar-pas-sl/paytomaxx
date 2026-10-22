import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

const SUB = '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f';
const TRAEFIK = '10.0.1.7';
const CF_EDGE = '162.158.94.21';
const CLIENTE = '83.45.120.7';

function setup(dbUser: Record<string, unknown> | null | Error, req: Record<string, unknown> = {}) {
  const findUnique =
    dbUser instanceof Error ? vi.fn().mockRejectedValue(dbUser) : vi.fn().mockResolvedValue(dbUser);
  const tx = { user: { findUnique } };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const request: Record<string, unknown> = {
    user: { sub: SUB, tenantId: '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01', role: 'OWNER', email: 'jefe@grupo-luna.es', sid: 'family' },
    headers: {},
    raw: { socket: { remoteAddress: TRAEFIK } },
    ...req,
  };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  const sessions = { liveSession: vi.fn().mockResolvedValue({ userId: SUB }), hasTwoFactor: vi.fn().mockResolvedValue(true) };
  return { guard: new SuperAdminGuard(prisma as never, sessions as never), ctx, request, findUnique };
}

const ACTIVO = { id: SUB, email: 'jefe@grupo-luna.es', isSuperAdmin: true, deletedAt: null, totpSecret: 'sealed-secret' };

describe('SuperAdminGuard — la decisión es de la base, no del JWT', () => {
  it('claims inventados en la sesión (isSuperAdmin: true) no bastan si la base dice que no', async () => {
    const { guard, ctx } = setup(
      { ...ACTIVO, isSuperAdmin: false },
      { user: { sub: SUB, role: 'OWNER', isSuperAdmin: true, superadmin: true } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('isSuperAdmin null/undefined en la base → 403', async () => {
    for (const flag of [null, undefined]) {
      const { guard, ctx } = setup({ ...ACTIVO, isSuperAdmin: flag });
      await expect(guard.canActivate(ctx)).rejects.toThrow(/super-admins/);
    }
  });

  it('busca solo por el id de la sesión (no por email ni por cabeceras)', async () => {
    const { guard, ctx, findUnique } = setup(ACTIVO, {
      headers: { 'x-user-id': 'ffffffff-0000-4000-8000-000000000000', 'x-superadmin': 'true' },
    });
    await guard.canActivate(ctx);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: SUB } });
  });

  it('el rol del local activo no importa: un WAITER super-admin en la base pasa', async () => {
    const { guard, ctx } = setup(ACTIVO, { user: { sub: SUB, role: 'WAITER', sid: 'family' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('si la base falla, se corta (no deja pasar)', async () => {
    const { guard, ctx, request } = setup(new Error('connection terminated'));
    await expect(guard.canActivate(ctx)).rejects.toThrow(/connection terminated/);
    expect(request.superAdmin).toBeUndefined();
  });
});

describe('SuperAdminGuard — quién queda apuntado para la auditoría', () => {
  it('IP real detrás de Cloudflare (CF-Connecting-IP con último salto de Cloudflare)', async () => {
    const { guard, ctx, request } = setup(ACTIVO, {
      headers: { 'cf-connecting-ip': CLIENTE, 'x-forwarded-for': `${CLIENTE}, ${CF_EDGE}` },
    });
    await guard.canActivate(ctx);
    expect((request.superAdmin as SuperAdminActor).ip).toBe(CLIENTE);
  });

  it('CF-Connecting-IP inventada sin pasar por Cloudflare: se apunta la IP real', async () => {
    const { guard, ctx, request } = setup(ACTIVO, {
      headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': `9.9.9.9, ${CLIENTE}` },
    });
    await guard.canActivate(ctx);
    expect((request.superAdmin as SuperAdminActor).ip).toBe(CLIENTE);
  });

  it('sin IP conocida → ip undefined (no "null" ni cadena vacía)', async () => {
    const { guard, ctx, request } = setup(ACTIVO, { raw: undefined });
    await guard.canActivate(ctx);
    expect((request.superAdmin as SuperAdminActor).ip).toBeUndefined();
  });

  it('User-Agent: se recorta a 300 caracteres; repetido (array) → undefined', async () => {
    const largo = setup(ACTIVO, { headers: { 'user-agent': `Mozilla/5.0 ${'x'.repeat(500)}` } });
    await largo.guard.canActivate(largo.ctx);
    expect((largo.request.superAdmin as SuperAdminActor).userAgent).toHaveLength(300);

    const repetido = setup(ACTIVO, { headers: { 'user-agent': ['Mozilla/5.0', 'curl/8.0'] } });
    await repetido.guard.canActivate(repetido.ctx);
    expect((repetido.request.superAdmin as SuperAdminActor).userAgent).toBeUndefined();
  });

  it('el email apuntado es el de la base, no el del JWT', async () => {
    const { guard, ctx, request } = setup({ ...ACTIVO, email: 'nuevo@grupo-luna.es' });
    await guard.canActivate(ctx);
    expect((request.superAdmin as SuperAdminActor).email).toBe('nuevo@grupo-luna.es');
  });
});

describe('@CurrentSuperAdmin', () => {
  function factory() {
    class Dummy {
      handler(): void {}
    }
    CurrentSuperAdmin()(Dummy.prototype, 'handler', 0);
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Dummy, 'handler') as Record<
      string,
      { factory: (d: unknown, c: ExecutionContext) => SuperAdminActor }
    >;
    const entry = Object.values(meta)[0];
    if (!entry) throw new Error('sin metadatos');
    return entry.factory;
  }
  const ctxWith = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  it('devuelve el super-admin que dejó el guard', () => {
    const actor: SuperAdminActor = { id: SUB, email: 'jefe@grupo-luna.es', ip: CLIENTE };
    expect(factory()(undefined, ctxWith({ superAdmin: actor }))).toBe(actor);
  });

  it('sin el guard delante (solo una sesión normal) → 403', () => {
    expect(() => factory()(undefined, ctxWith({ user: { sub: SUB, role: 'OWNER' } }))).toThrow(ForbiddenException);
  });
});
