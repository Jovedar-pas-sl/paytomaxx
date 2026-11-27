import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MoneyMapQuerySchema } from '@nightpay/contracts';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { STAFF_PERMISSION_KEY, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { MoneyMapController } from './money-map.controller';

describe('GET /v1/admin/money-map', () => {
  it('el dueño y el encargado con permiso de informes', () => {
    const handler = MoneyMapController.prototype.get;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['OWNER', 'MANAGER']);
    expect(Reflect.getMetadata(STAFF_PERMISSION_KEY, handler)).toBe('reports');
  });

  it('pasa la consulta al servicio con el local del token', async () => {
    const map = { salesCents: 1, scope: { kind: 'period' } };
    // Sin noche abierta: unas fechas van enteras también a la encargada.
    const svc = { forQuery: vi.fn().mockResolvedValue(map), currentWindow: vi.fn().mockResolvedValue({ open: false, from: new Date() }) };
    const controller = new MoneyMapController(svc as never, {} as never);
    await expect(controller.get({ tenantId: 't-1', role: 'MANAGER' } as never, { night: 'current' })).resolves.toEqual(map);
    expect(svc.forQuery).toHaveBeenCalledWith('t-1', { night: 'current' });
  });

  it('la ficha de la chica o del camarero: dueño y encargado (sin permiso de informes)', async () => {
    const handler = MoneyMapController.prototype.staffFicha;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['OWNER', 'MANAGER']);
    expect(Reflect.getMetadata(STAFF_PERMISSION_KEY, handler)).toBeUndefined();
    const fichas = { ficha: vi.fn().mockResolvedValue({ person: { id: 'p-1' } }) };
    const controller = new MoneyMapController({} as never, fichas as never);
    await expect(controller.staffFicha('t-1', 'p-1')).resolves.toEqual({ person: { id: 'p-1' } });
    expect(fichas.ficha).toHaveBeenCalledWith('t-1', 'p-1');
  });

  it('la consulta: una noche o unas fechas, no las dos; las dos fechas o ninguna', () => {
    expect(MoneyMapQuerySchema.safeParse({}).success).toBe(true);
    expect(MoneyMapQuerySchema.safeParse({ night: 'current' }).success).toBe(true);
    expect(MoneyMapQuerySchema.safeParse({ night: '22222222-2222-4222-8222-222222222222' }).success).toBe(true);
    expect(MoneyMapQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
    expect(MoneyMapQuerySchema.safeParse({ night: 'ayer' }).success).toBe(false);
    expect(MoneyMapQuerySchema.safeParse({ night: 'current', from: '2026-10-01', to: '2026-10-02' }).success).toBe(false);
    expect(MoneyMapQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
    expect(MoneyMapQuerySchema.safeParse({ from: '1/10/2026', to: '2026-10-02' }).success).toBe(false);
    expect(MoneyMapQuerySchema.safeParse({ nightId: 'x' }).success).toBe(false);
  });

  it('un periodo por instantes: fromAt, o fromAt y toAt, con zona y en orden', () => {
    const ok = (q: unknown) => MoneyMapQuerySchema.safeParse(q).success;
    expect(ok({ fromAt: '2026-11-13T05:00:00.000Z' })).toBe(true);
    expect(ok({ fromAt: '2026-11-13T05:00:00.000Z', toAt: '2026-11-16T05:31:00.000Z' })).toBe(true);
    expect(ok({ fromAt: '2026-11-13T06:00:00+01:00', toAt: '2026-11-16T06:31:00+01:00' })).toBe(true);
    // toAt solo, sin zona, al revés o igual.
    expect(ok({ toAt: '2026-11-16T05:31:00.000Z' })).toBe(false);
    expect(ok({ fromAt: '2026-11-13T05:00:00' })).toBe(false);
    expect(ok({ fromAt: '2026-11-13T05:00:00.000Z', toAt: '2026-11-16T05:31:00' })).toBe(false);
    expect(ok({ fromAt: '2026-11-16T05:31:00.000Z', toAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
    expect(ok({ fromAt: '2026-11-13T05:00:00.000Z', toAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
    expect(ok({ fromAt: '13/11/2026' })).toBe(false);
    // Nunca junto a una noche ni a unas fechas.
    expect(ok({ night: 'current', fromAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
    expect(ok({ night: '22222222-2222-4222-8222-222222222222', fromAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
    expect(ok({ from: '2026-11-01', to: '2026-11-02', fromAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
    expect(ok({ from: '2026-11-01', to: '2026-11-02', toAt: '2026-11-13T05:00:00.000Z' })).toBe(false);
  });

  it('el encargado sin permiso de informes: 403 (el mismo guarda que night y from/to)', async () => {
    const guardOf = (role: 'OWNER' | 'MANAGER', staffPermissions: unknown) => {
      const venue = { findUnique: async () => ({ staffPermissions }) };
      const prisma = { asSystem: async (fn: (tx: unknown) => unknown) => fn({ venue }) };
      const ctx = {
        getHandler: () => MoneyMapController.prototype.get,
        switchToHttp: () => ({
          getRequest: () => ({ user: { sub: 'u-1', role, tenantId: 't-1' }, query: { fromAt: '2026-11-13T05:00:00.000Z' } }),
        }),
      } as unknown as ExecutionContext;
      return new StaffPermissionGuard(new Reflector(), prisma as never).canActivate(ctx);
    };
    await expect(guardOf('OWNER', null)).resolves.toBe(true);
    await expect(guardOf('MANAGER', null)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'STAFF_PERMISSION_DENIED', permission: 'reports' }),
    });
    await expect(guardOf('MANAGER', { roles: { MANAGER: { reports: true } } })).resolves.toBe(true);
  });
});
