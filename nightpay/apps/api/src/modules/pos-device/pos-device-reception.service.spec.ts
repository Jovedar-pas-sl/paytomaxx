import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PosDeviceReceptionService } from './pos-device-reception.service';
import { posReference, sha256 } from './paytef';
import type { PosDevice } from './device.guard';

/**
 * Recepción en el datáfono: qué ofrece (según Ajustes y el permiso de los
 * datáfonos), la recarga en efectivo (con su terminalId) y la recarga con
 * tarjeta, que se crea como cobro de ESTE datáfono y queda «empezada» aquí.
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02';
const PAY = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';
const device: PosDevice = { terminalId: 'term-recepcion', tenantId: SALA, label: 'Recepción', zone: null, tokenHash: sha256('x') };

function make(o: { venue?: Record<string, unknown>; walletTenant?: string; cashReason?: string | null } = {}) {
  const venue = { id: SALA, walletGroup: 'grupo', paymentMethods: null, pausedAt: null, business: null, ...o.venue };
  const tx = {
    venue: { findUnique: vi.fn().mockResolvedValue(venue) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    walletCard: { findUnique: vi.fn().mockResolvedValue({ token: FICHA, uid: null, walletId: WALLET, status: 'ISSUED' }) },
    clientWallet: {
      findUnique: vi.fn().mockResolvedValue({
        id: WALLET, tenantId: o.walletTenant ?? SALA, walletGroup: 'grupo', status: 'DEPLETED', shortCode: 'K7Q4M2',
        mergedIntoId: null, blockedAt: null, pinHash: null,
      }),
    },
  };
  const prisma = {
    venue: tx.venue,
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const payments = {
    create: vi.fn().mockResolvedValue({ id: PAY, amountCents: 5_000, walletId: WALLET, status: 'CREATED' }),
  };
  const cash = {
    topUp: vi.fn().mockResolvedValue({ walletId: WALLET, balanceCents: 5_000 }),
    cashBlockedReason: vi.fn().mockResolvedValue(o.cashReason === undefined ? null : o.cashReason),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const cls = { get: vi.fn().mockReturnValue({ traceId: 'traza' }) };
  const svc = new PosDeviceReceptionService(prisma as never, payments as never, cash as never, audit as never, cls as never);
  return { svc, tx, payments, cash, audit };
}

describe('qué ofrece la recepción en este datáfono', () => {
  it('por defecto: tarjeta (datáfono + saldo) y fichas; el efectivo según el permiso de los datáfonos', async () => {
    const reason = 'El dueño no deja cobrar recargas en efectivo en el datáfono';
    const { svc, cash } = make({ cashReason: reason });
    await expect(svc.options(device)).resolves.toEqual({ card: true, cash: false, cashBlockedReason: reason, nfc: true });
    expect(cash.cashBlockedReason).toHaveBeenCalledWith(SALA, { terminalId: 'term-recepcion' });
  });

  it('con el datáfono o el saldo apagados, sin tarjeta; en pausa, tampoco; sin fichas NFC, sin ficha', async () => {
    await expect(make({ venue: { paymentMethods: { pos: false } } }).svc.options(device)).resolves.toMatchObject({ card: false, cash: true });
    await expect(make({ venue: { paymentMethods: { wallet: false } } }).svc.options(device)).resolves.toMatchObject({ card: false });
    await expect(make({ venue: { pausedAt: new Date() } }).svc.options(device)).resolves.toMatchObject({ card: false });
    await expect(make({ venue: { paymentMethods: { nfc: false } } }).svc.options(device)).resolves.toMatchObject({ nfc: false, card: true });
  });
});

describe('recargar en la recepción del datáfono', () => {
  it('en efectivo: la recarga es del datáfono (sin persona)', async () => {
    const { svc, cash } = make();
    const body = { amountCents: 5_000, idempotencyKey: 'clave-0001', wallet: { create: true as const } };
    await svc.cashTopUp(device, body);
    expect(cash.topUp).toHaveBeenCalledWith(SALA, { terminalId: 'term-recepcion' }, body);
  });

  it('con tarjeta, saldo nuevo: cobro de este datáfono, sin persona, empezado aquí; la referencia es la del lector', async () => {
    const { svc, payments, tx, audit } = make();
    const out = await svc.cardTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0002', wallet: { create: true } });
    expect(out).toEqual({ paymentId: PAY, reference: posReference(PAY), amountCents: 5_000, walletId: WALLET });
    expect(payments.create).toHaveBeenCalledWith(
      SALA,
      'reception:term-recepcion:clave-0002',
      { amountCents: 5_000, currency: 'EUR', wallet: { create: true } },
      undefined,
      { viaDevice: { terminalId: 'term-recepcion' } },
    );
    expect(tx.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: PAY,
        eventType: 'pos.device_started',
        payload: { terminalId: 'term-recepcion', reception: true },
      }),
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.reception_card_topup', targetId: PAY }));
  });

  it('con tarjeta a la ficha acercada: el saldo de la ficha (aunque esté a 0); de otro local del grupo, en efectivo', async () => {
    const { svc, payments } = make();
    await svc.cardTopUp(device, { amountCents: 2_000, idempotencyKey: 'clave-0003', wallet: { card: FICHA } });
    expect(payments.create.mock.calls[0]![2]).toEqual({ amountCents: 2_000, currency: 'EUR', wallet: { walletId: WALLET } });
    const otro = make({ walletTenant: NORTE });
    await expect(
      otro.svc.cardTopUp(device, { amountCents: 2_000, idempotencyKey: 'clave-0004', wallet: { card: FICHA } }),
    ).rejects.toThrow(/otro local del grupo/);
    expect(otro.payments.create).not.toHaveBeenCalled();
  });

  it('si el cobro no trae su saldo, no se sigue (no se cobra una recarga sin saldo)', async () => {
    const { svc, payments } = make();
    payments.create.mockResolvedValueOnce({ id: PAY, amountCents: 5_000, walletId: null });
    await expect(
      svc.cardTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0005', wallet: { create: true } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
