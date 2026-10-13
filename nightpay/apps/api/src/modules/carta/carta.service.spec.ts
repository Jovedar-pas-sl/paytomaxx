import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CartaService } from './carta.service';

function makeService(existing: Record<string, unknown> | null = null) {
  const prisma = {
    serviceItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'item-1',
        active: true,
        ...data,
      })),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(existing ?? {}),
        ...data,
      })),
    },
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new CartaService(prisma as any, audit as any);
  return { service, prisma, audit };
}

describe('CartaService', () => {
  it('la chica solo ve servicios activos de chica', async () => {
    const { service, prisma } = makeService();
    await service.listForStaff('tenant-1', 'OPERATOR');
    expect(prisma.serviceItem.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: 'tenant-1',
      active: true,
      category: 'CHICA_SERVICE',
    });
  });

  it('el camarero ve todos los activos', async () => {
    const { service, prisma } = makeService();
    await service.listForStaff('tenant-1', 'WAITER');
    expect(prisma.serviceItem.findMany.mock.calls[0]![0].where).toEqual({ tenantId: 'tenant-1', active: true });
  });

  it('crear guarda el servicio en el local de quien lo crea y deja registro', async () => {
    const { service, prisma, audit } = makeService();
    await service.create('tenant-1', 'owner-1', {
      name: '30 min',
      durationMin: 30,
      priceCents: 10000,
      category: 'CHICA_SERVICE',
    });
    expect(prisma.serviceItem.create.mock.calls[0]![0].data).toMatchObject({
      tenantId: 'tenant-1',
      name: '30 min',
      priceCents: 10000,
      durationMin: 30,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'carta.item.created' }));
  });

  it('editar un servicio de otro local → no encontrado', async () => {
    const { service } = makeService(null);
    await expect(service.update('tenant-1', 'owner-1', 'item-x', { priceCents: 5000 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('desactivar solo cambia "active" y deja registro del antes y después', async () => {
    const before = { id: 'item-1', name: '30 min', priceCents: 10000, active: true };
    const { service, prisma, audit } = makeService(before);
    await service.update('tenant-1', 'owner-1', 'item-1', { active: false });
    expect(prisma.serviceItem.update.mock.calls[0]![0].data).toEqual({ active: false });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'carta.item.updated', payload: expect.objectContaining({ before }) }),
    );
  });
});
