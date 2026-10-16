import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SuperAdminGuard } from './superadmin.guard';

const SUB = '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f';

function setup(user: Record<string, unknown> | null) {
  const findUnique = vi.fn().mockResolvedValue(user);
  const tx = { user: { findUnique } };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const guard = new SuperAdminGuard(prisma as never);
  const req: Record<string, unknown> = {
    user: { sub: SUB, tenantId: 'otro-local', role: 'OWNER' },
    headers: { 'user-agent': 'Mozilla/5.0' },
    ip: '10.0.0.1',
    socket: { remoteAddress: '203.0.113.7' },
  };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  return { guard, ctx, req, prisma, findUnique };
}

describe('SuperAdminGuard — isSuperAdmin leído de la base en cada petición', () => {
  it('super-admin activo: pasa y deja quién es (id, email, IP, navegador) en la petición', async () => {
    const { guard, ctx, req, prisma, findUnique } = setup({ id: SUB, email: 'jefe@x.es', isSuperAdmin: true, deletedAt: null });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Sin el filtro del local activo de la sesión (puede estar en otro local).
    expect(prisma.acrossVenues).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SUB } }));
    expect(req.superAdmin).toEqual({ id: SUB, email: 'jefe@x.es', ip: '203.0.113.7', userAgent: 'Mozilla/5.0' });
  });

  it('el JWT dice super-admin pero en la base ya no lo es → 403', async () => {
    const { guard, ctx } = setup({ id: SUB, email: 'x@x.es', isSuperAdmin: false, deletedAt: null });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dado de baja o inexistente → 403', async () => {
    const gone = setup({ id: SUB, email: 'x@x.es', isSuperAdmin: true, deletedAt: new Date() });
    await expect(gone.guard.canActivate(gone.ctx)).rejects.toThrow(/super-admins/);
    const missing = setup(null);
    await expect(missing.guard.canActivate(missing.ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin sesión → 401 (no se consulta la base)', async () => {
    const { guard, ctx, req, findUnique } = setup(null);
    delete req.user;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
