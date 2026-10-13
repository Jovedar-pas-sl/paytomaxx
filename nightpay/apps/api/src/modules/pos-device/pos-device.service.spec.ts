import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { InvalidTransitionError } from '../payments/payment.machine';
import { PosDeviceService } from './pos-device.service';
import { posReference, sha256 } from './paytef';
import type { PosDevice } from './device.guard';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const device: PosDevice = { terminalId: 'term-1', tenantId: 't-1', label: 'Barra 1', zone: 'BARRA' };

function payment(o: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    tenantId: 't-1',
    status: 'CREATED',
    captureMethod: 'POS_EXTERNAL',
    amountCents: 10_000,
    currency: 'EUR',
    qrExpiresAt: new Date(Date.now() + 10 * 60_000),
    posOperationNumber: null,
    posTerminalId: null,
    tipGoesTo: null,
    createdBy: { role: 'OPERATOR' },
    ...o,
  };
}

const lockedRow = {
  id: PAYMENT_ID,
  tenantId: 't-1',
  status: 'CREATED',
  amountCents: 10_000,
  availableAmountCents: 10_000,
  providerTxId: null,
  provider: null,
  createdByUserId: 'op-1',
  walletId: null,
  tipCents: 0,
  tipGoesTo: null,
  tipBeneficiaryUserId: null,
  revenueCategory: 'CHICA_SERVICE',
};

function makeService(opts: { payment?: ReturnType<typeof payment> | null; started?: boolean } = {}) {
  const tx = {
    payment: {
      findFirst: vi.fn().mockResolvedValue(opts.payment === undefined ? payment() : opts.payment),
      findMany: vi.fn().mockResolvedValue([]),
    },
    paymentEvent: {
      create: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(opts.started === false ? 0 : 1),
    },
    terminal: {
      findFirst: vi.fn().mockResolvedValue({ id: 'term-1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    posTerminalOp: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    asSystem: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    venue: { findUnique: vi.fn().mockResolvedValue({ name: 'Local Centro' }) },
  };
  // La transición ejecuta el "prepare" del datáfono con la fila bloqueada.
  const prepareTx = {
    payment: { update: vi.fn().mockResolvedValue({}) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prepared: unknown[] = [];
  const payments = {
    transition: vi.fn().mockImplementation(async (_id: string, _ev: unknown, _t: string, o?: { prepare?: (t: unknown, l: unknown) => Promise<unknown> }) => {
      if (o?.prepare) prepared.push(await o.prepare(prepareTx, lockedRow));
    }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const cls = { get: vi.fn().mockReturnValue(undefined) };
  const svc = new PosDeviceService(prisma as never, payments as never, audit as never, cls as never);
  return { svc, tx, payments, prepareTx, prepared };
}

const approved = {
  approved: true,
  authorisationCode: '047215',
  paytefOperationNumber: '99812',
  transactionReference: posReference(PAYMENT_ID),
  requestedAmount: 10_000,
  cardInformation: { hiddenCardNumber: '************1111', cardTypeCode: 'VI', isContactless: true },
};

const events = (tx: ReturnType<typeof makeService>['tx']) =>
  tx.paymentEvent.create.mock.calls.map((c) => (c[0] as { data: { eventType: string } }).data.eventType);

describe('venta en el datáfono', () => {
  it('aprobada → pagado en una sola transacción: operación, tarjeta y pasarela', async () => {
    const { svc, tx, payments, prepareTx, prepared } = makeService();
    const out = await svc.reportResult(device, PAYMENT_ID, approved);
    expect(out).toMatchObject({ status: 'PAID', code: 'A6B' });
    expect(payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      { type: 'POS_CONFIRMED', posReceiptRef: '047215' },
      't-1',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(prepareTx.payment.update).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID },
      data: expect.objectContaining({
        posOperationNumber: '99812',
        posTerminalId: 'term-1',
        terminalId: 'term-1',
        authCode: '047215',
        cardLast4: '1111',
        cardBrand: '1',
        payMethodCode: 'PAX_CONTACTLESS',
      }),
    });
    // La transición escribe la pasarela y la operación con lo que devuelve "prepare".
    expect(prepared[0]).toEqual({ provider: 'PAYTEF', providerTxId: '99812' });
    // "Pagado en el datáfono" se apunta dentro de la misma transacción.
    expect(prepareTx.paymentEvent.create.mock.calls[0]![0]).toMatchObject({
      data: { eventType: 'pos.device_confirmed', payload: { operationNumber: '99812', terminalId: 'term-1' } },
    });
    expect(events(tx)).toEqual(['pos.device_result']);
  });

  it('propina pedida en el datáfono → se reparte en la misma transacción', async () => {
    const { svc, prepareTx, prepared } = makeService();
    await svc.reportResult(device, PAYMENT_ID, { ...approved, tipAmount: 500 });
    expect(prepareTx.payment.update.mock.calls[0]![0]).toMatchObject({
      data: { tipCents: 500, availableAmountCents: 10_500, tipGoesTo: 'operator' },
    });
    expect(prepared[0]).toMatchObject({ tipCents: 500, availableAmountCents: 10_500 });
  });

  it('propina fuera de lo normal → no se acepta, hay que anular', async () => {
    const { svc, payments } = makeService();
    expect(await svc.reportResult(device, PAYMENT_ID, { ...approved, tipAmount: 20_000 })).toMatchObject({
      status: 'MISMATCH',
    });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('denegada → el cobro sigue pendiente para reintentar', async () => {
    const { svc, payments } = makeService();
    const out = await svc.reportResult(device, PAYMENT_ID, { approved: false, resultText: 'Saldo insuficiente' });
    expect(out).toEqual({ status: 'DECLINED', message: 'Saldo insuficiente' });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('aprobada sin referencia o sin importe → no se acepta', async () => {
    const { svc } = makeService();
    const { transactionReference: _r, ...noRef } = approved;
    const { requestedAmount: _a, ...noAmount } = approved;
    await expect(svc.reportResult(device, PAYMENT_ID, noRef)).rejects.toThrow(BadRequestException);
    await expect(svc.reportResult(device, PAYMENT_ID, noAmount)).rejects.toThrow(/importe/);
  });

  it('cobro no iniciado en este datáfono → no se paga, hay que anular', async () => {
    const { svc, payments } = makeService({ started: false });
    expect(await svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({
      status: 'MISMATCH',
      message: expect.stringContaining('no se inició en este datáfono'),
    });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('el mismo resultado otra vez, ya pagado → pagado, sin repetir nada', async () => {
    const { svc, payments } = makeService({
      payment: payment({ status: 'AUTHORIZED', posOperationNumber: '99812', posTerminalId: 'term-1' }),
    });
    expect(await svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({ status: 'PAID' });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('cobro ya pagado por otra vía → doble cobro: anular en el datáfono', async () => {
    const { svc, tx } = makeService({ payment: payment({ status: 'AUTHORIZED' }) });
    expect(await svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({
      status: 'DUPLICATE',
      operationNumber: '99812',
    });
    expect(events(tx)).toContain('payment.duplicate_charge');
  });

  it('importe distinto, cobro caducado u operación ya usada en este datáfono → anular', async () => {
    const amount = makeService();
    expect(await amount.svc.reportResult(device, PAYMENT_ID, { ...approved, requestedAmount: 9000 })).toMatchObject({
      status: 'MISMATCH',
    });
    expect(events(amount.tx)).toContain('pos.charge_mismatch');

    const expired = makeService({ payment: payment({ status: 'EXPIRED' }) });
    expect(await expired.svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({ status: 'MISMATCH' });

    const reused = makeService();
    reused.payments.transition.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    expect(await reused.svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({
      status: 'MISMATCH',
      message: expect.stringContaining('otro cobro'),
    });
  });

  it('otro lo confirmó mientras se cobraba → doble cobro (nada queda a medias)', async () => {
    const { svc, tx, payments } = makeService();
    payments.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZED', 'POS_CONFIRMED'));
    tx.payment.findFirst.mockResolvedValueOnce(payment()).mockResolvedValueOnce(payment({ status: 'AUTHORIZED' }));
    expect(await svc.reportResult(device, PAYMENT_ID, approved)).toMatchObject({ status: 'DUPLICATE' });
  });

  it('una operación de otro cobro no se acepta; un cobro de otro local no existe', async () => {
    const { svc } = makeService();
    await expect(
      svc.reportResult(device, PAYMENT_ID, { ...approved, transactionReference: 'NPOTRO' }),
    ).rejects.toThrow(/no es de este cobro/);
    const other = makeService({ payment: null });
    await expect(other.svc.reportResult(device, PAYMENT_ID, approved)).rejects.toThrow(NotFoundException);
  });

  it('antes de cobrar: referencia e importe; si ya no está pendiente, no', async () => {
    const { svc, tx } = makeService();
    expect(await svc.start(device, PAYMENT_ID)).toEqual({
      reference: posReference(PAYMENT_ID),
      amountCents: 10_000,
      currency: 'EUR',
    });
    expect(events(tx)).toEqual(['pos.device_started']);
    const paid = makeService({ payment: payment({ status: 'AUTHORIZED' }) });
    await expect(paid.svc.start(device, PAYMENT_ID)).rejects.toThrow(/ya no está pendiente/);
  });
});

describe('anular en el datáfono', () => {
  it('solo operaciones que el datáfono aprobó para este cobro', async () => {
    const ok = makeService();
    await ok.svc.reportVoid(device, PAYMENT_ID, { operationNumber: '99812', approved: true });
    expect(events(ok.tx)).toEqual(['pos.voided']);

    const forged = makeService();
    forged.tx.paymentEvent.count.mockResolvedValueOnce(0);
    await expect(
      forged.svc.reportVoid(device, PAYMENT_ID, { operationNumber: '1', approved: true }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('vinculación', () => {
  it('el código se canjea una vez por la credencial (solo se guarda su hash)', async () => {
    const { svc, tx } = makeService();
    tx.terminal.findFirst.mockResolvedValueOnce({
      id: 'term-1',
      tenantId: 't-1',
      label: 'Barra 1',
      zone: 'BARRA',
      venue: { name: 'Local Centro' },
    });
    const out = await svc.pair('abcd-2345');
    const call = tx.terminal.updateMany.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(call.where).toMatchObject({ id: 'term-1', pairingCodeHash: sha256('ABCD2345') });
    expect(call.data.deviceTokenHash).toBe(sha256(out.token));
    expect(call.data.pairingCodeHash).toBeNull();
    expect(out).toMatchObject({ venueName: 'Local Centro', terminal: { label: 'Barra 1' } });
  });

  it('dos datáfonos con el mismo código a la vez → solo uno; caducado → no', async () => {
    const race = makeService();
    race.tx.terminal.findFirst.mockResolvedValueOnce({
      id: 'term-1',
      tenantId: 't-1',
      label: 'Barra 1',
      zone: null,
      venue: { name: 'Local' },
    });
    race.tx.terminal.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(race.svc.pair('ABCD2345')).rejects.toThrow(NotFoundException);

    const expired = makeService();
    expired.tx.terminal.findFirst.mockResolvedValueOnce(null);
    await expect(expired.svc.pair('XXXX-XXXX')).rejects.toThrow(NotFoundException);
  });
});

describe('cuadre con el cierre del datáfono', () => {
  it('cuadra por operación de este datáfono y por importe', async () => {
    const { svc, tx } = makeService();
    tx.payment.findMany.mockResolvedValueOnce([
      { posOperationNumber: '1', amountCents: 10_000, tipCents: 0 },
      { posOperationNumber: '4', amountCents: 2000, tipCents: 0 },
    ]);
    const out = await svc.reportShift(device, [
      { paytefOperationNumber: '1', opType: 'sale', amountWithSign: 10_000 },
      { paytefOperationNumber: 2, opType: 'SALE', amountWithSign: '50,00' },
      { paytefOperationNumber: '3', opType: 'refund', amountWithSign: -500 },
      { paytefOperationNumber: '4', opType: 'sale', amountWithSign: 9_000 },
    ]);
    expect(out).toEqual({
      total: 3,
      matched: 1,
      unmatched: [
        { operationNumber: '2', amountCents: 5000, occurredAt: null },
        { operationNumber: '4', amountCents: 9000, occurredAt: null },
      ],
    });
    expect(tx.payment.findMany.mock.calls[0]![0]).toMatchObject({ where: { posTerminalId: 'term-1' } });
  });
});
