import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MoneyMapQuerySchema } from '@nightpay/contracts';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { STAFF_PERMISSION_KEY } from '../venues/staff-permission.guard';
import { MoneyMapController } from './money-map.controller';

describe('GET /v1/admin/money-map', () => {
  it('el dueño y el encargado con permiso de informes', () => {
    const handler = MoneyMapController.prototype.get;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['OWNER', 'MANAGER']);
    expect(Reflect.getMetadata(STAFF_PERMISSION_KEY, handler)).toBe('reports');
  });

  it('pasa la consulta al servicio con el local del token', async () => {
    const map = { salesCents: 1, scope: { kind: 'period' } };
    const svc = { forQuery: vi.fn().mockResolvedValue(map) };
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
});
