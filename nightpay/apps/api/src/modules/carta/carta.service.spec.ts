import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartaService } from './carta.service';

function makeService(existing: Record<string, unknown> | null = null, sections: Record<string, unknown> | null = null) {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
    withTenant: vi.fn(),
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
  prisma.withTenant.mockImplementation(async (_tenant: string, fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new CartaService(prisma as any, audit as any);
  return { service, prisma, audit };
}

describe('CartaService', () => {
  it.each(['create', 'update'] as const)('%s serializa con la plantilla: bloquea el local antes de leer, validar y escribir', async (method) => {
    const { service, prisma } = makeService({ id: 'item-1', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR', components: null });
    if (method === 'create') await service.create('tenant-1', 'owner', { name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' });
    else await service.update('tenant-1', 'owner', 'item-1', { priceCents: 1200 });
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const lockOrder = prisma.$queryRaw.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(prisma.serviceItem[method].mock.invocationCallOrder[0]!);
    if (method === 'update') expect(lockOrder).toBeLessThan(prisma.serviceItem.findFirst.mock.invocationCallOrder[0]!);
    else expect(lockOrder).toBeLessThan(prisma.venue.findUnique.mock.invocationCallOrder[0]!);
  });
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

describe('CartaService: logo o foto e icono', () => {
  const ROW = { id: 'item-1', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR', components: null, icon: null, image: null };
  function withImages(existing: Record<string, unknown> | null) {
    const made = makeService(existing);
    const images = { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 1 }), findFirst: vi.fn() };
    Object.assign(made.prisma, { serviceItemImage: images, serviceItem: { ...made.prisma.serviceItem, findFirstOrThrow: vi.fn().mockResolvedValue({ ...ROW, image: { contentHash: 'b'.repeat(64) } }) } });
    (made.prisma as unknown as { asSystem: unknown }).asSystem = vi.fn(async (fn: (tx: unknown) => unknown) => fn(made.prisma));
    return { ...made, images };
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]).toString('base64');

  it('la carta lleva el icono y la ruta versionada de la imagen (o null)', async () => {
    const { service, prisma } = makeService();
    prisma.serviceItem.findMany.mockResolvedValueOnce([
      { ...ROW, id: 'a', icon: 'gin_tonic', image: { contentHash: 'c'.repeat(64) } },
      { ...ROW, id: 'b', icon: 'no_existe', image: null },
    ]);
    const list = await service.listAll('tenant-1');
    expect(list[0]).toMatchObject({ icon: 'gin_tonic', imageUrl: `/v1/services/a/image/${'c'.repeat(64)}` });
    expect(list[1]).toMatchObject({ icon: null, imageUrl: null });
    expect(JSON.stringify(list)).not.toContain('"image"');
  });

  it('subir: producto de otro local (o que no existe) → 404 y nada se escribe', async () => {
    const { service, images, audit } = withImages(null);
    const bytes = (await import('../../../test/support/webp-fixture')).webpFixture().toString('base64');
    await expect(service.setImage('tenant-1', 'owner', 'item-1', bytes)).rejects.toBeInstanceOf(NotFoundException);
    expect(images.upsert).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('subir: un PNG o un SVG se rechaza antes de tocar la base', async () => {
    const { service, prisma, images } = withImages({ id: 'item-1' });
    await expect(service.setImage('tenant-1', 'owner', 'item-1', png)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setImage('tenant-1', 'owner', 'item-1', Buffer.from('<svg/>').toString('base64'))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(images.upsert).not.toHaveBeenCalled();
  });

  it('subir: guarda con el local del token, bajo el candado, y deja rastro', async () => {
    const { service, prisma, images, audit } = withImages({ id: 'item-1' });
    const { webpFixture } = await import('../../../test/support/webp-fixture');
    const item = await service.setImage('tenant-1', 'owner', 'item-1', webpFixture().toString('base64'));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(images.upsert.mock.calls[0]![0].create).toMatchObject({ serviceItemId: 'item-1', tenantId: 'tenant-1', width: 128, height: 128 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'carta.item.image_set', tenantId: 'tenant-1' }));
    expect(item.imageUrl).toBe(`/v1/services/item-1/image/${'b'.repeat(64)}`);
  });

  it('quitar: producto de otro local → 404; sin imagen no deja rastro', async () => {
    const none = withImages(null);
    await expect(none.service.removeImage('tenant-1', 'owner', 'item-1')).rejects.toBeInstanceOf(NotFoundException);
    const { service, images, audit } = withImages({ id: 'item-1' });
    images.deleteMany.mockResolvedValueOnce({ count: 0 });
    await service.removeImage('tenant-1', 'owner', 'item-1');
    expect(images.deleteMany.mock.calls[0]![0].where).toEqual({ serviceItemId: 'item-1', tenantId: 'tenant-1' });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('servir: pide producto Y huella; sin coincidencia, null', async () => {
    const { service, images } = withImages(null);
    images.findFirst.mockResolvedValueOnce(null);
    expect(await service.imageFor('item-1', 'd'.repeat(64))).toBeNull();
    expect(images.findFirst.mock.calls[0]![0].where).toEqual({ serviceItemId: 'item-1', contentHash: 'd'.repeat(64) });
    images.findFirst.mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]), contentHash: 'd'.repeat(64) });
    const hit = await service.imageFor('item-1', 'd'.repeat(64));
    expect(hit?.data.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('el icono se guarda por PATCH y se puede quitar con null', async () => {
    const { service, prisma } = makeService({ id: 'item-1', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR', components: null });
    await service.update('tenant-1', 'owner', 'item-1', { icon: 'cerveza' });
    await service.update('tenant-1', 'owner', 'item-1', { icon: null });
    expect(prisma.serviceItem.update.mock.calls.map((c) => c[0].data.icon)).toEqual(['cerveza', null]);
  });
});
