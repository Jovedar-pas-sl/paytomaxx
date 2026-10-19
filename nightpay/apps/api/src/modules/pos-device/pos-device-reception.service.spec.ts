import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

function make(
  o: {
    venue?: Record<string, unknown>;
    walletTenant?: string;
    cashReason?: string | null;
    /** El datáfono está marcado como el de la recepción (por defecto, sí). */
    reception?: boolean;
    /** Cobro ya creado con esa Idempotency-Key. */
    existingSale?: { status: string; qrExpiresAt: Date } | null;
    /** Lo cargado en 24 h por el datáfono y por el saldo. */
    used?: { terminal: number; wallet: number };
    cashTaken?: number;
    sale?: Record<string, unknown> | null;
  } = {},
) {
  const venue = { id: SALA, walletGroup: 'grupo', paymentMethods: null, pausedAt: null, business: null, ...o.venue };
  const used = o.used ?? { terminal: 0, wallet: 0 };
  const tx = {
    venue: { findUnique: vi.fn().mockResolvedValue(venue) },
    terminal: { findFirst: vi.fn().mockResolvedValue({ reception: o.reception ?? true }) },
    payment: {
      findUnique: vi.fn().mockResolvedValue(o.existingSale ?? null),
      findFirst: vi.fn().mockResolvedValue(o.sale === undefined ? null : o.sale),
    },
    walletCashTopUp: { count: vi.fn().mockResolvedValue(o.cashTaken ?? 0) },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => [
      { cents: sql.join('?').includes('"walletId" =') ? used.wallet : used.terminal },
    ]),
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    walletCard: {
      findUnique: vi.fn().mockResolvedValue({ token: FICHA, uid: null, walletId: WALLET, status: 'ISSUED' }),
      count: vi.fn().mockResolvedValue(1),
    },
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

describe('el efectivo, solo en el datáfono de la recepción (dinero #5)', () => {
  it('un datáfono sin marcar no ofrece efectivo ni lo cobra (ni pregunta el permiso)', async () => {
    const { svc, cash } = make({ reception: false });
    const opts = await svc.options(device);
    expect(opts).toMatchObject({ cash: false, card: true });
    expect(opts.cashBlockedReason).toMatch(/Recepción/);
    expect(cash.cashBlockedReason).not.toHaveBeenCalled();
    await expect(
      svc.cashTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0101', wallet: { create: true } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(cash.topUp).not.toHaveBeenCalled();
  });
});

describe('con la ficha, «Fichas NFC» encendido (pagos #6)', () => {
  it('apagado: ni tarjeta ni efectivo a la ficha; saldo nuevo sí', async () => {
    const off = () => make({ venue: { paymentMethods: { nfc: false } } });
    const a = off();
    await expect(a.svc.cardTopUp(device, { amountCents: 2_000, idempotencyKey: 'clave-0201', wallet: { card: FICHA } })).rejects.toMatchObject({
      response: { code: 'PAYMENT_METHOD_DISABLED', method: 'nfc' },
    });
    expect(a.payments.create).not.toHaveBeenCalled();
    const b = off();
    await expect(b.svc.cashTopUp(device, { amountCents: 2_000, idempotencyKey: 'clave-0202', wallet: { card: FICHA } })).rejects.toMatchObject({
      response: { code: 'PAYMENT_METHOD_DISABLED', method: 'nfc' },
    });
    expect(b.cash.topUp).not.toHaveBeenCalled();
    const c = off();
    await c.svc.cardTopUp(device, { amountCents: 2_000, idempotencyKey: 'clave-0203', wallet: { create: true } });
    expect(c.payments.create).toHaveBeenCalled();
  });
});

describe('la misma Idempotency-Key en la recepción (pagos #8)', () => {
  it('cobro ya pagado, caducado o cancelado → 409 y no se vuelve a mandar al lector', async () => {
    for (const existingSale of [
      { status: 'AUTHORIZED', qrExpiresAt: new Date(Date.now() + 60_000) },
      { status: 'AUTHORIZING', qrExpiresAt: new Date(Date.now() + 60_000) },
      { status: 'CREATED', qrExpiresAt: new Date(Date.now() - 1) },
      { status: 'EXPIRED', qrExpiresAt: new Date(Date.now() - 1) },
    ]) {
      const { svc, payments, tx } = make({ existingSale });
      await expect(
        svc.cardTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0301', wallet: { create: true } }),
      ).rejects.toThrow(/ya se cobró, caducó o se canceló/);
      expect(payments.create).not.toHaveBeenCalled();
      expect(tx.paymentEvent.create).not.toHaveBeenCalled();
    }
  });

  it('sigue abierto → la misma venta, sin volver a contar el tope ni apuntarla otra vez', async () => {
    const { svc, payments, tx, audit } = make({ existingSale: { status: 'CREATED', qrExpiresAt: new Date(Date.now() + 60_000) } });
    const out = await svc.cardTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0302', wallet: { create: true } });
    expect(out.paymentId).toBe(PAY);
    expect(payments.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('topes de la recepción (seguridad #3)', () => {
  it('el datáfono pasa su tope de 24 h → 409, no se crea nada y queda en Incidencias', async () => {
    const { svc, payments, audit } = make({ used: { terminal: 14_990_00, wallet: 0 } });
    await expect(
      svc.cardTopUp(device, { amountCents: 20_00, idempotencyKey: 'clave-0401', wallet: { create: true } }),
    ).rejects.toMatchObject({ response: { code: 'RECEPTION_LIMIT', limit: 'terminal_daily' } });
    expect(payments.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pos.reception_limit_exceeded',
        targetId: 'term-recepcion',
        payload: expect.objectContaining({ limit: 'terminal_daily', method: 'card', amountCents: 20_00, usedCents: 14_990_00, capCents: 15_000_00 }),
      }),
    );
  });

  it('el saldo pasa su tope de 24 h (tarjeta o efectivo) → 409; justo en el tope, sí', async () => {
    const card = make({ used: { terminal: 0, wallet: 4_990_00 } });
    await expect(
      card.svc.cardTopUp(device, { amountCents: 20_00, idempotencyKey: 'clave-0402', wallet: { card: FICHA } }),
    ).rejects.toMatchObject({ response: { limit: 'wallet_daily' } });
    const cash = make({ used: { terminal: 0, wallet: 4_990_00 } });
    await expect(
      cash.svc.cashTopUp(device, { amountCents: 20_00, idempotencyKey: 'clave-0403', wallet: { card: FICHA } }),
    ).rejects.toMatchObject({ response: { limit: 'wallet_daily' } });
    expect(cash.cash.topUp).not.toHaveBeenCalled();
    const exact = make({ used: { terminal: 0, wallet: 4_990_00 } });
    await exact.svc.cashTopUp(device, { amountCents: 10_00, idempotencyKey: 'clave-0404', wallet: { card: FICHA } });
    expect(exact.cash.topUp).toHaveBeenCalled();
  });

  it('el mismo botón del efectivo otra vez no vuelve a contar el tope (lo devuelve CashTopUpService)', async () => {
    const { svc, cash, tx } = make({ cashTaken: 1, used: { terminal: 99_000_00, wallet: 0 } });
    await svc.cashTopUp(device, { amountCents: 5_000, idempotencyKey: 'clave-0405', wallet: { create: true } });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(cash.topUp).toHaveBeenCalled();
  });
});

describe('el resultado de una recarga en este datáfono (datafono #6)', () => {
  const sale = (status: string) => ({ id: PAY, status, amountCents: 5_000, walletId: WALLET });

  it('sumada: el saldo de ahora (también el de una ficha que ya existía) y el código a medias', async () => {
    const { svc, tx } = make({ sale: sale('AUTHORIZED') });
    tx.clientWallet.findUnique.mockResolvedValueOnce({ shortCode: 'K7Q4M2', balanceCents: 12_000, pinHash: 'h' });
    await expect(svc.topUpResult(device, PAY)).resolves.toEqual({
      paymentId: PAY,
      status: 'CREDITED',
      amountCents: 5_000,
      walletId: WALLET,
      codeHint: 'K7Q-•••',
      balanceCents: 12_000,
      hasPin: true,
      hasCard: true,
    });
    // Solo las de este datáfono, sin persona, recargas y de la última hora.
    expect(tx.payment.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: PAY, tenantId: SALA, terminalId: 'term-recepcion', createdByUserId: null, captureMethod: 'WALLET_TOPUP' },
    });
  });

  it('pendiente de Paytef o sin cobrar: sin saldo; de otro datáfono o vieja: 404', async () => {
    const pending = make({ sale: sale('AUTHORIZING') });
    await expect(pending.svc.topUpResult(device, PAY)).resolves.toMatchObject({ status: 'PENDING', balanceCents: null });
    const open = make({ sale: sale('CREATED') });
    await expect(open.svc.topUpResult(device, PAY)).resolves.toMatchObject({ status: 'OPEN', balanceCents: null });
    const gone = make({ sale: sale('EXPIRED') });
    await expect(gone.svc.topUpResult(device, PAY)).resolves.toMatchObject({ status: 'NOT_PAID' });
    await expect(make({ sale: null }).svc.topUpResult(device, PAY)).rejects.toBeInstanceOf(NotFoundException);
  });
});
