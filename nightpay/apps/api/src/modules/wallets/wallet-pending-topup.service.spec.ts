import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PendingTopUpService } from './wallet-pending-topup.service';

/**
 * Recargas pendientes de asignar: se cobra primero (sin el NFC del cliente),
 * el dinero queda en un saldo propio y se suma al del cliente al acercar su
 * NFC o teclear su código. Nunca se pierde.
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const PROV = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f71'; // el saldo provisional de la recarga
const CLIENTE = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'; // el saldo de siempre del cliente
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';

const pablo = { userId: 'u-pablo', role: 'WAITER', tenantId: SALA };
const lola = { userId: 'u-lola', role: 'OPERATOR', tenantId: SALA };
const otraChica = { userId: 'u-otra', role: 'OPERATOR', tenantId: SALA };

type Row = Record<string, unknown>;

function setup(o: { pending?: Row | null; target?: Row; terminal?: Row | null; venue?: Row; walletId?: string | null } = {}) {
  const pending: Row | null =
    o.pending === null
      ? null
      : {
          id: PROV, status: 'ACTIVE', balanceCents: 5_000, mergedIntoId: null,
          pendingAssignAt: new Date('2026-10-17T01:00:00+02:00'), pendingAssignById: 'u-lola', ...o.pending,
        };
  const target: Row = {
    id: CLIENTE, tenantId: SALA, walletGroup: null, shortCode: 'K7Q4M2', pinHash: null, status: 'ACTIVE',
    mergedIntoId: null, blockedAt: null, pendingAssignAt: null, ...o.target,
  };
  const tx = {
    terminal: { findFirst: vi.fn(async () => (o.terminal === undefined ? { externalId: 'BARRA-1' } : o.terminal)) },
    clientWallet: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [
        { id: PROV, balanceCents: 5_000, pendingAssignAt: new Date('2026-10-17T01:00:00+02:00'), pendingAssignById: 'u-lola' },
        { id: 'w-2', balanceCents: 2_000, pendingAssignAt: new Date('2026-10-17T00:30:00+02:00'), pendingAssignById: null },
      ]),
      findFirst: vi.fn(async (a: { where: Row }) => {
        if ('shortCode' in a.where) return a.where.shortCode === 'K7Q4M2' ? target : null;
        return a.where.id === PROV ? pending : null;
      }),
      findUnique: vi.fn(async (a: { where: Row }) => (a.where.id === target.id ? target : a.where.id === PROV ? pending : null)),
    },
    walletCard: { findUnique: vi.fn(async () => ({ id: 'c', token: FICHA, uid: null, walletId: target.id, status: 'ISSUED' })) },
    user: { findMany: vi.fn(async () => [{ id: 'u-lola', displayName: 'Lola', email: 'lola@bambu.es' }]) },
    venue: { findUnique: vi.fn(async () => ({ walletGroup: null, paymentMethods: null, ...o.venue })) },
  };
  const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
  const prisma = { ...tx, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  const audit = { log: vi.fn(async () => undefined) };
  const charges = { mergeInto: vi.fn(async () => ({ balanceCents: 7_500 })) };
  const payments = {
    create: vi.fn(async () => ({ id: 'pay-1', status: 'CREATED', walletId: o.walletId === undefined ? PROV : o.walletId, qrToken: 'qr' })),
  };
  const moduleRef = { get: vi.fn(() => payments) };
  const svc = new PendingTopUpService(prisma as never, audit as never, charges as never, moduleRef as never);
  return { svc, tx, audit, charges, payments };
}

describe('cobrar primero (sin su NFC)', () => {
  it('una recarga con tarjeta a un saldo nuevo, en el primer datáfono del local, marcada como pendiente de asignar', async () => {
    const { svc, payments, tx } = setup();
    const out = await svc.start(lola, { amountCents: 5_000, idempotencyKey: 'rec-pendiente-0001' });
    expect(out).toMatchObject({ id: 'pay-1', walletId: PROV });
    expect(payments.create).toHaveBeenCalledWith(
      SALA,
      'rec-pendiente-0001',
      { amountCents: 5_000, currency: 'EUR', terminalExternalId: 'BARRA-1', wallet: { create: true } },
      { userId: 'u-lola', role: 'OPERATOR' },
    );
    expect(tx.clientWallet.updateMany).toHaveBeenCalledWith({
      where: { id: PROV, tenantId: SALA, pendingAssignAt: null, mergedIntoId: null },
      data: { pendingAssignAt: expect.any(Date), pendingAssignById: 'u-lola' },
    });
  });

  it('sin datáfono en el local no se puede (409); si el cobro no trae su saldo, tampoco', async () => {
    await expect(setup({ terminal: null }).svc.start(lola, { amountCents: 5_000, idempotencyKey: 'rec-1234567' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(setup({ walletId: null }).svc.start(lola, { amountCents: 5_000, idempotencyKey: 'rec-1234567' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('las pendientes', () => {
  it('las cobradas del local, con quién las cobró; la chica solo ve las suyas', async () => {
    const { svc, tx } = setup();
    await expect(svc.list(pablo)).resolves.toEqual([
      { walletId: PROV, amountCents: 5_000, since: '2026-10-16T23:00:00.000Z', byName: 'Lola' },
      { walletId: 'w-2', amountCents: 2_000, since: '2026-10-16T22:30:00.000Z', byName: null },
    ]);
    expect(tx.clientWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: SALA, pendingAssignAt: { not: null }, mergedIntoId: null, status: 'ACTIVE', balanceCents: { gt: 0 } },
      }),
    );
    await svc.list(lola);
    expect(tx.clientWallet.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ pendingAssignById: 'u-lola' }) }),
    );
  });
});

describe('asignarla a su saldo', () => {
  it('con su código: se suma a su saldo (como «Sumar a mi saldo») y queda en el registro', async () => {
    const { svc, charges, audit } = setup();
    await expect(svc.assign(pablo, PROV, { code: 'k7q-4m2' })).resolves.toEqual({
      walletId: CLIENTE, codeHint: 'K7Q-•••', amountCents: 5_000, balanceCents: 7_500,
    });
    expect(charges.mergeInto).toHaveBeenCalledWith(PROV, CLIENTE);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.topup_assigned',
        actorId: 'u-pablo',
        targetId: CLIENTE,
        payload: { from: PROV, amountCents: 5_000, via: 'code' },
      }),
    );
  });

  it('con su NFC (si el local acepta NFC)', async () => {
    const ok = setup();
    await expect(ok.svc.assign(lola, PROV, { card: FICHA, uid: '04A2' })).resolves.toMatchObject({ walletId: CLIENTE });
    const off = setup({ venue: { paymentMethods: { nfc: false } } });
    await expect(off.svc.assign(lola, PROV, { card: FICHA })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED' }),
    });
    expect(off.charges.mergeInto).not.toHaveBeenCalled();
  });

  it('no pendiente, de otra chica o de otro local: 404; ya asignada o sin pagar: 409', async () => {
    await expect(setup({ pending: null }).svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ pending: { pendingAssignAt: null } }).svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(setup().svc.assign(otraChica, PROV, { code: 'K7Q4M2' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ pending: { mergedIntoId: CLIENTE } }).svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toThrow(/ya está asignada/);
    await expect(setup({ pending: { balanceCents: 0 } }).svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toThrow(/pagada/);
    await expect(setup({ pending: { status: 'EXPIRED' } }).svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toThrow(/pagada/);
  });

  it('a sí misma o a otra recarga pendiente, no', async () => {
    const self = setup({ target: { id: PROV } });
    await expect(self.svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toThrow(/propia recarga/);
    const other = setup({ target: { pendingAssignAt: new Date() } });
    await expect(other.svc.assign(pablo, PROV, { code: 'K7Q4M2' })).rejects.toThrow(/también está pendiente/);
    expect(other.charges.mergeInto).not.toHaveBeenCalled();
  });

  it('un código que no es de ningún saldo del local: 404 y no se toca nada', async () => {
    const { svc, charges } = setup();
    await expect(svc.assign(pablo, PROV, { code: 'ZZZ999' })).rejects.toBeInstanceOf(NotFoundException);
    expect(charges.mergeInto).not.toHaveBeenCalled();
  });
});
