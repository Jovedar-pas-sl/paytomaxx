import { DEFAULT_NIGHT_SETTINGS } from '@nightpay/contracts';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { InvalidTransitionError } from '../payments/payment.machine';
import { PosDeviceService } from './pos-device.service';
import { posReference, sha256 } from './paytef';
import type { PosDevice } from './device.guard';
import type { ApprovalProof } from '../gateways/gateway.adapter';
import { PaytefDeviceSaleProver, type PosSaleClaim } from './pos-sale-proof';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const device: PosDevice = {
  terminalId: 'term-1',
  tenantId: 't-1',
  label: 'Barra 1',
  zone: 'BARRA',
  tokenHash: sha256('credencial-en-uso'),
};

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

/** Paytef confirma lo que dice el datáfono (lo de siempre en estas pruebas, salvo que se diga otra cosa). */
const paytefConfirms = (claim: PosSaleClaim): Promise<ApprovalProof> =>
  Promise.resolve({ kind: 'confirmed', amountCents: claim.amountCents, currency: 'EUR' });

function makeService(
  opts: {
    payment?: ReturnType<typeof payment> | null;
    started?: boolean;
    locked?: Partial<typeof lockedRow>;
    prove?: (claim: PosSaleClaim) => Promise<ApprovalProof>;
  } = {},
) {
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
      if (o?.prepare) prepared.push(await o.prepare(prepareTx, { ...lockedRow, ...opts.locked }));
    }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const cls = { get: vi.fn().mockReturnValue(undefined) };
  const prover = { prove: vi.fn(opts.prove ?? paytefConfirms) };
  const svc = new PosDeviceService(prisma as never, payments as never, audit as never, cls as never, prover);
  return { svc, tx, payments, prepareTx, prepared, audit, prover };
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
    // La transición escribe la pasarela, la operación y la propina (ninguna) con lo que devuelve "prepare".
    expect(prepared[0]).toEqual({
      provider: 'PAYTEF',
      providerTxId: '99812',
      tipCents: 0,
      availableAmountCents: 10_000,
      tipGoesTo: null,
    });
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

  it('sin propina en el datáfono → la que puso quien creó el cobro no cuenta (nadie la pagó)', async () => {
    const { svc, prepareTx, prepared } = makeService({
      locked: { tipCents: 3_000, availableAmountCents: 13_000, tipGoesTo: 'operator' },
    });
    await svc.reportResult(device, PAYMENT_ID, approved);
    expect(prepareTx.payment.update.mock.calls[0]![0]).toMatchObject({
      data: { tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null },
    });
    expect(prepared[0]).toMatchObject({ tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null });
  });

  it('con propina en el datáfono → la del datáfono, no la de quien creó el cobro', async () => {
    const { svc, prepared } = makeService({
      locked: { tipCents: 3_000, availableAmountCents: 13_000, tipGoesTo: 'operator' },
    });
    await svc.reportResult(device, PAYMENT_ID, { ...approved, tipAmount: 200 });
    expect(prepared[0]).toMatchObject({ tipCents: 200, availableAmountCents: 10_200, tipGoesTo: 'operator' });
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

  it('otro importe con propina: el aviso dice lo que cobró el lector (importe + propina), lo mismo que se anula', async () => {
    const { svc } = makeService();
    // Cobro de 100 €; el lector cobra 150 € + 20 € de propina.
    const out = await svc.reportResult(device, PAYMENT_ID, { ...approved, requestedAmount: 15_000, tipAmount: 2_000 });
    expect(out).toMatchObject({ status: 'MISMATCH' });
    const message = (out as { message: string }).message;
    expect(message).toContain('Se cobraron 170,00 €');
    expect(message).toContain('20,00 € de propina');
    expect(message).toContain('el cobro era de 100,00 €');
    // Sin propina, como siempre.
    const plain = await makeService().svc.reportResult(device, PAYMENT_ID, { ...approved, requestedAmount: 9_000 });
    expect((plain as { message: string }).message).toMatch(/^Se cobraron 90,00 € y el cobro era de 100,00 €/);
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
    // También la de una recarga que quedó pendiente de la prueba de Paytef.
    expect(ok.tx.paymentEvent.count.mock.calls[0]![0]).toMatchObject({
      where: { OR: [{ eventType: { in: ['pos.device_confirmed', 'pos.charge_mismatch', 'payment.approval_unverified'] } }, {}] },
    });

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
    // Credencial recién entregada: cuenta desde ahora y sin una nueva pendiente.
    expect(call.data.deviceTokenIssuedAt).toBeInstanceOf(Date);
    expect(call.data.deviceTokenNextHash).toBeNull();
    expect(out).toMatchObject({ venueName: 'Local Centro', terminal: { label: 'Barra 1' } });
  });

  it('rotar: credencial nueva pendiente, solo si la que llama sigue siendo la buena', async () => {
    const { svc, tx, audit } = makeService();
    const out = await svc.rotateToken(device);
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.terminal.updateMany).toHaveBeenCalledWith({
      where: { id: 'term-1', deviceTokenHash: device.tokenHash, active: true },
      // La fecha va con la nueva: la credencial en uso no se rejuvenece (seguridad #7).
      data: { deviceTokenNextHash: sha256(out.token), deviceTokenNextIssuedAt: expect.any(Date) },
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'terminal.device.token_rotated' }));
  });

  it('rotar con una credencial que ya no es la buena → 401', async () => {
    const { svc, tx, audit } = makeService();
    tx.terminal.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.rotateToken(device)).rejects.toThrow(UnauthorizedException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('desvincular borra también la credencial pendiente', async () => {
    const { svc, tx } = makeService();
    await svc.unpair('t-1', 'term-1', 'owner-1');
    expect(tx.terminal.update.mock.calls[0]![0]).toMatchObject({
      data: { deviceTokenHash: null, deviceTokenNextHash: null, deviceTokenIssuedAt: null },
    });
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

describe('recarga del saldo cobrada en la recepción del datáfono', () => {
  const topUp = payment({ captureMethod: 'WALLET_TOPUP', createdBy: null });

  it('la recarga que creó este datáfono, con la venta probada por Paytef, queda pagada (la suma al saldo va en la transición)', async () => {
    const { svc, payments, prepared, prover } = makeService({ payment: topUp, locked: { walletId: 'w-1', createdByUserId: null } });
    await expect(svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'PAID' });
    expect(prover.prove).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      tenantId: 't-1',
      terminalId: 'term-1',
      operationNumber: '99812',
      reference: posReference(PAYMENT_ID),
      amountCents: 10_000,
      authCode: '047215',
    });
    expect(payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      { type: 'POS_CONFIRMED', posReceiptRef: '047215' },
      't-1',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(prepared[0]).toMatchObject({ provider: 'PAYTEF', providerTxId: '99812', tipCents: 0 });
  });

  it('con propina en el lector: no se apunta y se pide anularla (una recarga no lleva propina)', async () => {
    const { svc, payments, tx } = makeService({ payment: topUp });
    const out = await svc.reportResult(device, PAYMENT_ID, { ...approved, tipAmount: 200 });
    expect(out).toMatchObject({ status: 'MISMATCH', operationNumber: '99812' });
    expect(out.message).toMatch(/no lleva propina/);
    expect(payments.transition).not.toHaveBeenCalled();
    expect(events(tx)).toContain('pos.charge_mismatch');
  });

  it('una recarga que no empezó este datáfono (p. ej. la del QR de una chica): no se cobra aquí', async () => {
    const { svc, payments } = makeService({ payment: topUp, started: false });
    await expect(svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'MISMATCH' });
    expect(payments.transition).not.toHaveBeenCalled();
  });
});

describe('la palabra del datáfono no basta: prueba de Paytef (seguridad #1)', () => {
  const topUp = payment({ captureMethod: 'WALLET_TOPUP', createdBy: null });
  const noProof = new PaytefDeviceSaleProver();
  const unverifiable = () => noProof.prove();
  const eventTypes = (calls: unknown[][]) => calls.map((c) => (c[0] as { data: { eventType: string } }).data.eventType);

  it('recarga sin poder probarla con Paytef → NO se suma: queda AUTHORIZING con la operación y la incidencia', async () => {
    const { svc, payments, prepareTx, prepared } = makeService({
      payment: topUp,
      locked: { walletId: 'w-1', createdByUserId: null },
      prove: unverifiable,
    });
    const out = await svc.reportResult(device, PAYMENT_ID, approved);
    expect(out).toMatchObject({ status: 'PENDING', operationNumber: '99812' });
    expect(out.message).toMatch(/NO se ha sumado al saldo/);
    // Nunca POS_CONFIRMED: la recarga no llega a AUTHORIZED (ni al saldo).
    expect(payments.transition).toHaveBeenCalledTimes(1);
    expect(payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      { type: 'AUTHORIZING' },
      't-1',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(prepared[0]).toEqual({ provider: 'PAYTEF', providerTxId: '99812' });
    const update = prepareTx.payment.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({ posOperationNumber: '99812', posTerminalId: 'term-1', authCode: '047215', cardLast4: '1111' });
    expect(update.data).not.toHaveProperty('authorizedAt');
    expect(prepareTx.paymentEvent.create.mock.calls[0]![0]).toMatchObject({
      data: {
        eventType: 'payment.approval_unverified',
        payload: { provider: 'PAYTEF', providerTxId: '99812', source: 'pos-device', reason: 'paytef-device-sin-consulta-servidor' },
      },
    });
  });

  it('el mismo resultado otra vez, ya en espera de Paytef → PENDING sin tocar nada', async () => {
    const waiting = payment({
      captureMethod: 'WALLET_TOPUP',
      createdBy: null,
      status: 'AUTHORIZING',
      posOperationNumber: '99812',
      posTerminalId: 'term-1',
    });
    const { svc, payments, prover } = makeService({ payment: waiting, prove: unverifiable });
    await expect(svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'PENDING' });
    expect(payments.transition).not.toHaveBeenCalled();
    expect(prover.prove).not.toHaveBeenCalled();
  });

  it('Paytef dice que no (o que fue otro importe) → no se paga: anular', async () => {
    const proofs: ApprovalProof[] = [
      { kind: 'rejected', reason: 'paytef-no-aprobado' },
      { kind: 'confirmed', amountCents: 100, currency: 'EUR' },
    ];
    for (const proof of proofs) {
      const { svc, payments, tx } = makeService({ payment: topUp, prove: () => Promise.resolve(proof) });
      const out = await svc.reportResult(device, PAYMENT_ID, approved);
      expect(out).toMatchObject({ status: 'MISMATCH', operationNumber: '99812' });
      expect(out.message).toMatch(/Paytef no tiene esta venta/);
      expect(payments.transition).not.toHaveBeenCalled();
      expect(events(tx)).toContain('pos.charge_mismatch');
    }
  });

  it('cobro de una chica sin la prueba: pagado como hasta ahora, apuntado «sin comprobar» en la misma transacción', async () => {
    const { svc, payments, prepareTx } = makeService({ prove: unverifiable });
    await expect(svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'PAID' });
    expect(payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      { type: 'POS_CONFIRMED', posReceiptRef: '047215' },
      't-1',
      expect.anything(),
    );
    expect(eventTypes(prepareTx.paymentEvent.create.mock.calls)).toEqual(['pos.device_confirmed', 'pos.device_unproven']);
  });

  it('con la prueba no queda nada «sin comprobar»; y no se pregunta a Paytef por un cobro que no vale', async () => {
    const ok = makeService();
    await ok.svc.reportResult(device, PAYMENT_ID, approved);
    expect(eventTypes(ok.prepareTx.paymentEvent.create.mock.calls)).toEqual(['pos.device_confirmed']);
    const notHere = makeService({ started: false });
    await notHere.svc.reportResult(device, PAYMENT_ID, approved);
    expect(notHere.prover.prove).not.toHaveBeenCalled();
  });

  it('otra recarga ya tenía esa operación → anular; la misma espera apuntada a la vez → PENDING', async () => {
    const clash = makeService({ payment: topUp, prove: unverifiable });
    clash.payments.transition.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(clash.svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'MISMATCH' });

    const twin = makeService({ payment: topUp, prove: unverifiable });
    twin.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZING', 'AUTHORIZING'));
    twin.tx.payment.findFirst
      .mockResolvedValueOnce(topUp)
      .mockResolvedValueOnce({ ...topUp, status: 'AUTHORIZING', posOperationNumber: '99812', posTerminalId: 'term-1' });
    await expect(twin.svc.reportResult(device, PAYMENT_ID, approved)).resolves.toMatchObject({ status: 'PENDING' });
  });
});

describe('GET /pos-device/me — «Pago con saldo» del local', () => {
  it('wallet: encendido por defecto; apagado en Formas de cobro → false (/pax esconde «Cobrar con saldo»)', async () => {
    const on = makeService();
    await expect(on.svc.me(device)).resolves.toEqual({
      terminal: { label: 'Barra 1', zone: 'BARRA' },
      venueName: 'Local Centro',
      wallet: true,
      // Ajustes de la noche (el teclado del PIN): sin nada guardado, los de fábrica.
      night: DEFAULT_NIGHT_SETTINGS,
    });
    const off = makeService();
    (off.svc as unknown as { prisma: { venue: { findUnique: ReturnType<typeof vi.fn> } } }).prisma.venue.findUnique.mockResolvedValueOnce({
      name: 'Local Centro',
      paymentMethods: { wallet: false },
    });
    await expect(off.svc.me(device)).resolves.toMatchObject({ wallet: false });
  });
});
