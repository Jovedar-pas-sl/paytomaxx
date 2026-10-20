import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartaService } from './carta.service';

function makeService(existing: Record<string, unknown> | null = null, sections: Record<string, unknown> | null = null) {
  const prisma = {
    venue: { findUnique: vi.fn().mockResolvedValue({ sections }) },
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
  it('las apps ven lo activo de las secciones encendidas (con las partes de cada pack)', async () => {
    const { service, prisma } = makeService(null, { VENUE_FOOD: { enabled: false } });
    prisma.serviceItem.findMany.mockResolvedValueOnce([
      { id: 'a', name: 'Copa', category: 'VENUE_BAR', priceCents: 1000, components: null },
      { id: 'b', name: 'Bocadillo', category: 'VENUE_FOOD', priceCents: 500, components: null },
      {
        id: 'c',
        name: '1 h con habitación',
        category: 'CHICA_SERVICE',
        priceCents: 15000,
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12000 },
          { category: 'VENUE_ROOM', amountCents: 3000 },
        ],
      },
    ]);
    const list = await service.listForStaff('tenant-1', 'WAITER');
    expect(prisma.serviceItem.findMany.mock.calls[0]![0].where).toEqual({ tenantId: 'tenant-1', active: true });
    expect(list.map((i) => i.id)).toEqual(['a', 'c']);
    expect(list[1]!.components).toHaveLength(2);
  });

  it('cada persona ve solo lo que su puesto puede cobrar (la chica, Servicios; el pack, por su sección)', async () => {
    const { service, prisma } = makeService();
    const user = { findFirst: vi.fn().mockResolvedValue({ post: null }) };
    Object.assign(prisma, {
      user,
      asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ user, venue: prisma.venue })),
    });
    const rows = [
      { id: 'copa', name: 'Copa', category: 'VENUE_BAR', priceCents: 1000, components: null },
      { id: 'pack', name: '1 h con habitación', category: 'CHICA_SERVICE', priceCents: 15000, components: null },
      { id: 'viejo', name: 'Viejo', category: 'EXTRA', priceCents: 500, components: null },
    ];
    prisma.serviceItem.findMany.mockResolvedValue(rows);
    // Lo antiguo («Otros») se cobra en la sección de quien lo cobra: también sale.
    expect((await service.listForStaff('tenant-1', 'OPERATOR', 'chica-1')).map((i) => i.id)).toEqual(['pack', 'viejo']);
    // El camarero (Barra): la copa y lo antiguo.
    expect((await service.listForStaff('tenant-1', 'WAITER', 'cam-1')).map((i) => i.id)).toEqual(['copa', 'viejo']);
    expect((await service.listForStaff('tenant-1', 'OWNER', 'own-1')).map((i) => i.id)).toEqual(['copa', 'pack', 'viejo']);
  });

  it('pack: las partes tienen que sumar el precio y la sección del pack ser una de ellas (comprobado aquí)', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.create('tenant-1', 'owner-1', {
        name: '1 h con habitación',
        priceCents: 15000,
        category: 'CHICA_SERVICE',
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12000 },
          { category: 'VENUE_ROOM', amountCents: 2000 },
        ],
      }),
    ).rejects.toThrow(/suman 140,00 €/);
    await expect(
      service.create('tenant-1', 'owner-1', {
        name: 'Raro',
        priceCents: 15000,
        category: 'VENUE_BAR',
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12000 },
          { category: 'VENUE_ROOM', amountCents: 3000 },
        ],
      }),
    ).rejects.toThrow(/tiene que ser una de sus partes/);
    expect(prisma.serviceItem.create).not.toHaveBeenCalled();
  });

  it('una sección apagada no admite servicios nuevos (ni partes de un pack)', async () => {
    const { service } = makeService(null, { VENUE_ROOM: { enabled: false, label: 'Reservados' } });
    await expect(service.create('tenant-1', 'owner-1', { name: 'Hab', priceCents: 3000, category: 'VENUE_ROOM' })).rejects.toThrow(
      /«Reservados» está apagada/,
    );
    await expect(
      service.create('tenant-1', 'owner-1', {
        name: 'Pack',
        priceCents: 15000,
        category: 'CHICA_SERVICE',
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12000 },
          { category: 'VENUE_ROOM', amountCents: 3000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editar: el pack se comprueba con el precio guardado si no llega otro; null lo quita', async () => {
    const before = { id: 'item-1', name: 'Pack', priceCents: 15000, category: 'CHICA_SERVICE', active: true, components: null };
    const { service, prisma } = makeService(before);
    await expect(
      service.update('tenant-1', 'owner-1', 'item-1', {
        components: [
          { category: 'CHICA_SERVICE', amountCents: 10000 },
          { category: 'VENUE_ROOM', amountCents: 3000 },
        ],
      }),
    ).rejects.toThrow(/suman 130,00 €/);
    await service.update('tenant-1', 'owner-1', 'item-1', { components: null });
    expect(prisma.serviceItem.update.mock.calls[0]![0].data).toHaveProperty('components');
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
