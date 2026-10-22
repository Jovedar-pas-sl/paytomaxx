import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CartaService } from './carta.service';

function setup(items: Array<Record<string, unknown>> = [], sections: unknown = null) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
    venue: { findUnique: vi.fn().mockResolvedValue({ sections }) },
    serviceItem: {
      findMany: vi.fn().mockResolvedValue(items),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
  };
  const prisma = { withTenant: vi.fn(async (_tenant: string, fn: (client: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  return { service: new CartaService(prisma as never, audit as never), tx, prisma, audit };
}
const copa = { id: 'copa', name: ' COPA ', category: 'VENUE_BAR', priceCents: 900, durationMin: null, sortOrder: 0, active: false, isInvitation: false, components: null };

describe('atomic reference carta', () => {
  it('requires explicit confirmation even for direct service callers', async () => {
    const { service, prisma } = setup();
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: false } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('locks the venue and reuses matching IDs while creating the remaining approved products', async () => {
    const { service, tx, prisma } = setup([copa]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).resolves.toEqual({ created: 12, updated: 1, kept: 0 });
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.serviceItem.findMany.mock.invocationCallOrder[0]!);
    expect(tx.serviceItem.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'copa' }, data: expect.objectContaining({ active: true, priceCents: 1000 }) }));
    expect(tx.serviceItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'Invitar a una copa', priceCents: 2000, isInvitation: true }) }));
  });

  it.each([
    ['duplicates', [copa, { ...copa, id: 'dup' }]],
    ['invitation', [{ ...copa, isInvitation: true }]],
    ['pack', [{ ...copa, components: [{ category: 'VENUE_BAR', amountCents: 900 }] }]],
  ])('prevalidates %s without writing any product', async (_kind, items) => {
    const { service, tx } = setup(items as Array<Record<string, unknown>>);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.serviceItem.create).not.toHaveBeenCalled();
    expect(tx.serviceItem.update).not.toHaveBeenCalled();
  });

  it('prevalidates disabled sections before writing even the first enabled product', async () => {
    const { service, tx } = setup([], { CHICA_SERVICE: { enabled: false } });
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.serviceItem.create).not.toHaveBeenCalled();
    expect(tx.serviceItem.update).not.toHaveBeenCalled();
  });
});
