import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CARTA_TEMPLATE } from '@nightpay/contracts';
import { CartaService } from './carta.service';

type Row = Record<string, unknown> & { id: string };

function setup(items: Row[] = [], sections: unknown = null) {
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

const COPA_ID = '00000000-0000-4000-8000-000000000001';
/** La copa que el dueño puso a 9 € y desactivó. */
const copa: Row = { id: COPA_ID, name: ' COPA ', category: 'VENUE_BAR', priceCents: 900, durationMin: null, sortOrder: 0, active: false, isInvitation: false, components: null };
const seenCopa = { priceCents: 900, durationMin: null, sortOrder: 0, active: false };
const created = (tx: ReturnType<typeof setup>['tx']) => tx.serviceItem.create.mock.calls.map(([arg]) => (arg as { data: { name: string } }).data.name);

describe('carta de referencia atómica', () => {
  it('pide la confirmación explícita también a quien llama al servicio directamente', async () => {
    const { service, prisma } = setup();
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: false } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('bloquea el local antes de leer y, por defecto, solo añade lo que falta: no toca el precio ni la desactivación del dueño', async () => {
    const { service, tx, prisma } = setup([copa]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).resolves.toEqual({ created: 11, updated: 0, kept: 1, skipped: 0 });
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.serviceItem.findMany.mock.invocationCallOrder[0]!);
    expect(tx.serviceItem.update).not.toHaveBeenCalled();
    expect(created(tx)).not.toContain('Copa');
    expect(tx.serviceItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'Copa con invitación', priceCents: 2000, isInvitation: true, sortOrder: 1 }) }));
  });

  it('actualiza un producto solo si se marcó y sigue como lo vio el dueño, sin cambiarle el nombre', async () => {
    const { service, tx, audit } = setup([copa]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true, update: [{ id: COPA_ID, seen: seenCopa }] }))
      .resolves.toEqual({ created: 11, updated: 1, kept: 0, skipped: 0 });
    expect(tx.serviceItem.update).toHaveBeenCalledWith({ where: { id: COPA_ID }, data: { durationMin: null, priceCents: 1000, sortOrder: 0, active: true } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ updatedIds: [COPA_ID] }) }));
  });

  it.each([
    ['otro precio', { ...copa, priceCents: 1200 }],
    ['ya no está', { ...copa, id: '00000000-0000-4000-8000-000000000009' }],
    ['ahora es un pack', { ...copa, components: [{ category: 'VENUE_BAR', amountCents: 500 }, { category: 'VENUE_FOOD', amountCents: 400 }] }],
  ])('un producto marcado que cambió (%s) → 409 sin escribir nada', async (_why, now) => {
    const { service, tx } = setup([now]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true, update: [{ id: COPA_ID, seen: seenCopa }] })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.serviceItem.create).not.toHaveBeenCalled();
    expect(tx.serviceItem.update).not.toHaveBeenCalled();
  });

  it('un producto marcado que otro administrador ya dejó como la referencia no es un conflicto', async () => {
    const { service, tx } = setup([{ ...copa, priceCents: 1000, active: true }]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true, update: [{ id: COPA_ID, seen: seenCopa }] }))
      .resolves.toEqual({ created: 11, updated: 0, kept: 1, skipped: 0 });
    expect(tx.serviceItem.update).not.toHaveBeenCalled();
  });

  it('omite las secciones apagadas y los duplicados sin bloquear el resto', async () => {
    const { service, tx } = setup([copa, { ...copa, id: 'dup' }], { CHICA_SERVICE: { enabled: false } });
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).resolves.toEqual({ created: 7, updated: 0, kept: 0, skipped: 5 });
    const names = created(tx);
    expect(names).not.toContain('30 min');
    expect(names).not.toContain('Copa');
    expect(names).toHaveLength(7);
  });

  it('no crea una segunda invitación si ya hay una con otro nombre', async () => {
    const invitation: Row = { ...copa, id: 'inv', name: 'Invita a Nerea', priceCents: 2500, active: true, isInvitation: true };
    const { service, tx } = setup([invitation]);
    await expect(service.applyTemplate('tenant-1', 'owner', { confirm: true })).resolves.toEqual({ created: CARTA_TEMPLATE.length - 1, updated: 0, kept: 0, skipped: 1 });
    expect(created(tx)).not.toContain('Copa con invitación');
    expect(tx.serviceItem.create.mock.calls.every(([arg]) => !(arg as { data: { isInvitation: boolean } }).data.isInvitation)).toBe(true);
  });
});
