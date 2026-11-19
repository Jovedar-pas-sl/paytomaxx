import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletChargesService } from './wallet-charges.service';

const FUTURE = new Date(Date.now() + 60_000);

function wallet(o: Record<string, unknown> = {}) {
  return {
    id: 'w-1',
    tenantId: 'home',
    walletGroup: 'principal',
    shortCode: 'K7Q4M2',
    balanceCents: 30_000,
    status: 'ACTIVE',
    identifier: 'Mesa 3',
    qrToken: 'tok',
    closeRequestedAt: null,
    ...o,
  };
}

function request(o: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    tenantId: 'other',
    walletId: 'w-1',
    requestedByUserId: 'op-1',
    amountCents: 10_000,
    category: 'CHICA_SERVICE',
    serviceName: '30 min',
    status: 'PENDING',
    expiresAt: FUTURE,
    ...o,
  };
}

function makeService(
  opts: { wallet?: ReturnType<typeof wallet> | null; venueGroup?: string | null; threshold?: number } = {},
) {
  const w = opts.wallet === undefined ? wallet() : opts.wallet;
  const tx = {
    // Reservados: el saldo de un reservado no se devuelve en dinero («Me voy»).
    reservation: { count: vi.fn().mockResolvedValue(0) },
    clientWallet: {
      findFirst: vi.fn().mockResolvedValue(w),
      findUnique: vi.fn().mockResolvedValue(w),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletChargeRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      // La referencia (C-0001) de cada consumo en la página del saldo.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'req-new', status: 'PENDING', ...data })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletConsumption: {
      create: vi.fn().mockResolvedValue({ id: 'cons-1' }),
      findFirst: vi.fn().mockResolvedValue({ authMethod: 'nfc_nopin' }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    operatorEarning: { create: vi.fn().mockResolvedValue({}) },
    // El mapa del dinero: carta, puesto, líneas y referencia del cobro.
    serviceItem: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'svc-1', name: '30 min', durationMin: 30, priceCents: 10_000, category: 'CHICA_SERVICE', active: true, components: null },
      ]),
    },
    paymentLine: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    chargeRefCounter: { upsert: vi.fn().mockResolvedValue({ lastRef: 41 }) },
    walletPayout: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    walletPasskey: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    walletCard: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue({ printedNumber: '1013' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    walletCardEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // QR de activación de un solo uso (el enlace nuevo del dueño va por él).
    walletActivationToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
    walletCashTopUp: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ role: 'OPERATOR', commissionBps: null, displayName: 'Lola' }),
      findFirst: vi.fn().mockResolvedValue({ post: null }),
    },
    venue: {
      findUnique: vi.fn().mockResolvedValue({ operatorCommissionDefaults: { CHICA_SERVICE: 9000 } }),
      // La página del saldo lee los locales de sus movimientos en su transacción.
      findMany: vi.fn().mockResolvedValue([{ id: 'other', name: 'Local Norte' }]),
    },
    // La fila bloqueada (FOR UPDATE) refleja la wallet de la prueba.
    $queryRaw: vi
      .fn()
      .mockResolvedValue(w ? [{ id: w.id, balanceCents: w.balanceCents, status: w.status }] : []),
    // El pago con el saldo deja su evento (detalle del pago) en SQL crudo.
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    asSystem: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    acrossVenues: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    walletPasskey: { count: vi.fn().mockResolvedValue(0) },
    walletCard: { count: vi.fn().mockResolvedValue(0) },
    venue: {
      findUnique: vi.fn().mockResolvedValue({
        name: 'Local Centro',
        walletGroup: opts.venueGroup === undefined ? 'principal' : opts.venueGroup,
        ...(opts.threshold !== undefined ? { refundApprovalThresholdCents: opts.threshold } : {}),
      }),
      findMany: vi.fn().mockResolvedValue([{ id: 'other', name: 'Local Norte' }]),
    },
    serviceItem: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'svc-1',
        name: '30 min',
        durationMin: 30,
        priceCents: 10_000,
        category: 'CHICA_SERVICE',
        active: true,
      }),
    },
  };
  const refunds = { registerBankRefund: vi.fn().mockResolvedValue({}) };
  const moduleRef = { get: vi.fn().mockReturnValue(refunds) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const totp = { assertForUser: vi.fn().mockResolvedValue(undefined), isEnabled: vi.fn().mockResolvedValue(true) };
  const svc = new WalletChargesService(prisma as never, audit as never, moduleRef as never, totp as never);
  return { svc, tx, prisma, refunds, audit, totp };
}

const chica = { userId: 'op-1', role: 'OPERATOR' as const, tenantId: 'other' };
const owner = { userId: 'own-1', role: 'OWNER' as const, tenantId: 'home' };
const manager = { userId: 'man-1', role: 'MANAGER' as const, tenantId: 'home' };

describe('la chica encuentra el saldo por el código del cliente', () => {
  it('vale en otro local del mismo grupo', async () => {
    const { svc } = makeService();
    const out = await svc.lookup('other', 'k7q-4m2');
    expect(out).toMatchObject({
      walletId: 'w-1',
      code: 'K7Q-4M2',
      balanceCents: 30_000,
      pendingRequest: false,
      isHomeVenue: false,
      closeRequested: false,
    });
  });

  it('saldo bloqueado por el super-admin → 409 WALLET_BLOCKED (ni recargarlo ni cobrarle)', async () => {
    const { svc } = makeService({ wallet: wallet({ blockedAt: new Date() }) });
    await expect(svc.lookup('other', 'K7Q4M2')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'WALLET_BLOCKED' }),
    });
  });

  it('no vale en un local de otro grupo; código mal escrito → aviso', async () => {
    const { svc } = makeService({ venueGroup: 'otro-dueño' });
    await expect(svc.lookup('ajeno', 'K7Q4M2')).rejects.toThrow(NotFoundException);
    await expect(makeService().svc.lookup('other', 'K7Q')).rejects.toThrow(/6 letras/);
  });
});

describe('un cobro solo lo sigue o lo retira quien lo hizo (o el encargado)', () => {
  const otraChica = { userId: 'op-2', role: 'OPERATOR' as const, tenantId: 'other' };
  const camarero = { userId: 'wt-1', role: 'WAITER' as const, tenantId: 'other' };
  const encargadoDelLocal = { userId: 'man-2', role: 'MANAGER' as const, tenantId: 'other' };

  it('otra chica o el camarero no ven el cobro de una compañera ni lo pueden cancelar', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(request({ requestedByUserId: 'op-1' }));
    for (const actor of [otraChica, camarero]) {
      await expect(svc.getRequest(actor, 'req-1')).rejects.toThrow(NotFoundException);
      await expect(svc.cancelRequest(actor, 'req-1')).rejects.toThrow(NotFoundException);
    }
    expect(tx.walletChargeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('la chica que lo hizo y el encargado del local, sí', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(request({ requestedByUserId: 'op-1' }));
    await expect(svc.getRequest(chica, 'req-1')).resolves.toMatchObject({ id: 'req-1', status: 'PENDING' });
    await expect(svc.getRequest(encargadoDelLocal, 'req-1')).resolves.toMatchObject({ id: 'req-1' });
    await expect(svc.cancelRequest(chica, 'req-1')).resolves.toEqual({ ok: true });
    await expect(svc.cancelRequest(encargadoDelLocal, 'req-1')).resolves.toEqual({ ok: true });
    // Siempre del local de quien lo pide.
    expect(tx.walletChargeRequest.findFirst.mock.calls[0]![0]).toMatchObject({ where: { id: 'req-1', tenantId: 'other' } });
    expect(tx.walletChargeRequest.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'req-1', tenantId: 'other', status: 'PENDING' },
      data: { status: 'CANCELED' },
    });
  });

  it('uno ya pagado o caducado no se cancela', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(request({ requestedByUserId: 'op-1' }));
    tx.walletChargeRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.cancelRequest(chica, 'req-1')).rejects.toThrow(/ya no está pendiente/);
  });
});

describe('la chica hace un cobro con QR', () => {
  it('con un servicio de la carta: precio y categoría del local; aún sin saldo (lo dice el cliente al pagar)', async () => {
    const { svc, tx } = makeService();
    // El contador del local (charge-store.assignChargeRef) da la 41.
    tx.$queryRaw.mockResolvedValueOnce([{ ref: 41 }]);
    const out = await svc.createQrCharge(chica, { serviceItemId: 'svc-1' });
    expect(out).toMatchObject({ status: 'PENDING', amountCents: 10_000, serviceName: '30 min', ref: 'C-0041' });
    expect(out.payToken.length).toBeGreaterThanOrEqual(32);
    expect(tx.walletChargeRequest.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', walletId: null, requestedByUserId: 'op-1', category: 'CHICA_SERVICE' },
    });
    // La referencia, lo último y en una sola sentencia: después del cobro y de su línea.
    const refCall = tx.$queryRaw.mock.calls.findIndex((c) => sqlOf(c).includes('charge_ref_counters'));
    expect(refCall).toBeGreaterThanOrEqual(0);
    expect(tx.$queryRaw.mock.invocationCallOrder[refCall]!).toBeGreaterThan(tx.paymentLine.createMany.mock.invocationCallOrder[0]!);
    // Su línea, en Servicios, con el cobro del saldo.
    expect(tx.paymentLine.createMany.mock.calls[0]![0]).toEqual({
      data: [
        {
          tenantId: 'other',
          walletChargeId: 'req-new',
          category: 'CHICA_SERVICE',
          serviceItemId: 'svc-1',
          label: '30 min',
          qty: 1,
          unitCents: 10_000,
          amountCents: 10_000,
          operatorCommissionBps: null,
          beneficiaryOperatorId: null,
          beneficiaryCents: null,
          chargerCents: null,
        },
      ],
    });
  });

  it('importe libre sin sección (o «Otros» de una app antigua): la de su rol, nunca EXTRA', async () => {
    const { svc, tx } = makeService();
    await svc.createQrCharge(chica, { amountCents: 1000, category: 'EXTRA' });
    expect(tx.walletChargeRequest.create.mock.calls[0]![0]).toMatchObject({ data: { category: 'CHICA_SERVICE' } });
    tx.user.findFirst.mockResolvedValueOnce({ post: 'COCINA' });
    await svc.createQrCharge({ userId: 'wt-1', role: 'WAITER', tenantId: 'other' }, { amountCents: 1500 });
    expect(tx.walletChargeRequest.create.mock.calls[1]![0]).toMatchObject({ data: { category: 'VENUE_FOOD' } });
  });

  it('el puesto manda: la chica no cobra la barra del saldo (403); el camarero de barra no cobra habitaciones', async () => {
    const { svc, tx } = makeService();
    await expect(svc.createQrCharge(chica, { amountCents: 1000, category: 'VENUE_BAR' })).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'SECTION_NOT_ALLOWED' }),
    });
    const waiter = { userId: 'wt-1', role: 'WAITER' as const, tenantId: 'other' };
    await expect(svc.createQrCharge(waiter, { amountCents: 1000, category: 'VENUE_ROOM' })).rejects.toThrow(/Barra/);
    expect(tx.walletChargeRequest.create).not.toHaveBeenCalled();
  });

  it('tope de «Otro importe» del local: también el camarero y el encargado (la carta no cuenta); el dueño, sin tope', async () => {
    const { svc, tx, prisma } = makeService();
    prisma.venue.findUnique.mockResolvedValue({ operatorMaxCobroCents: 20_000, walletGroup: 'principal' });
    const waiter = { userId: 'wt-1', role: 'WAITER' as const, tenantId: 'other' };
    const encargado = { ...manager, tenantId: 'other' };
    await expect(svc.createQrCharge(waiter, { amountCents: 25_000 })).rejects.toThrow('El máximo que puedes cobrar de una vez es 200,00 €');
    await expect(svc.createQrCharge(encargado, { amountCents: 25_000, category: 'VENUE_BAR' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.walletChargeRequest.create).not.toHaveBeenCalled();
    // La carta (el precio lo pone el local) y el dueño: sin tope.
    tx.serviceItem.findMany.mockResolvedValueOnce([
      { id: 'svc-2', name: 'Botella', durationMin: null, priceCents: 30_000, category: 'VENUE_BAR', active: true, components: null },
    ]);
    await expect(svc.createQrCharge(encargado, { serviceItemId: 'svc-2' })).resolves.toMatchObject({ amountCents: 30_000 });
    await expect(svc.createQrCharge({ ...owner, tenantId: 'other' }, { amountCents: 90_000, category: 'VENUE_BAR' })).resolves.toMatchObject({ amountCents: 90_000 });
    await expect(svc.createQrCharge(waiter, { amountCents: 20_000 })).resolves.toMatchObject({ amountCents: 20_000 });
  });

  it('varias cosas en un cobro del saldo: cada línea a su sección y el total del servidor', async () => {
    const { svc, tx } = makeService();
    const out = await svc.createQrCharge(manager, {
      lines: [
        { serviceItemId: 'svc-1', qty: 1 },
        { category: 'VENUE_BAR', amountCents: 2000, label: 'Copas' },
      ],
    });
    expect(out.amountCents).toBe(12_000);
    const data = tx.paymentLine.createMany.mock.calls[0]![0].data as Array<{ category: string; amountCents: number }>;
    expect(data.map((l) => [l.category, l.amountCents])).toEqual([
      ['CHICA_SERVICE', 10_000],
      ['VENUE_BAR', 2000],
    ]);
  });
});

describe('el cliente paga el QR con su Face ID', () => {
  /** El cobro con QR: sin saldo hasta que alguien lo paga. */
  function qrService() {
    const made = makeService();
    made.tx.walletChargeRequest.findUnique.mockResolvedValue(request({ walletId: null, payToken: 'pay-tok' }));
    // Dentro de la transacción, ya atado a este saldo.
    made.tx.walletChargeRequest.findFirst.mockResolvedValue(request());
    return made;
  }

  it('se ata a su saldo, descuenta, apunta el consumo en el local donde se cobra y la parte de la chica', async () => {
    const { svc, tx } = qrService();
    await svc.payQrCharge('pay-tok', 'w-1');
    expect(tx.walletChargeRequest.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'req-1', walletId: null, status: 'PENDING' },
      data: { walletId: 'w-1' },
    });
    expect(tx.walletConsumption.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', walletId: 'w-1', amountCents: 10_000, providedByUserId: 'op-1', idempotencyKey: 'charge-request:req-1' },
    });
    expect(tx.operatorEarning.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', operatorId: 'op-1', commissionBps: 9000, commissionCents: 9000 },
    });
    // El que paga un cobro sigue en el local: se le quita el "Me voy".
    expect(tx.clientWallet.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: 20_000, closeRequestedAt: null },
    });
    expect(tx.walletChargeRequest.updateMany.mock.calls[1]![0]).toMatchObject({
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'ACCEPTED', consumptionId: 'cons-1' },
    });
  });

  it('el consumo lleva fijado el % de plataforma del local de ahora (cambiarlo después no cambia lo gastado)', async () => {
    const { svc, tx } = qrService();
    tx.venue.findUnique.mockResolvedValue({ operatorCommissionDefaults: { CHICA_SERVICE: 9000 }, platformCommissionBps: 800 } as never);
    await svc.payQrCharge('pay-tok', 'w-1');
    expect(tx.walletConsumption.create.mock.calls[0]![0]).toMatchObject({ data: { platformCommissionBps: 800 } });
  });

  it('lo que ve el cliente: pendiente sin hora de pago; pagado con su hora («Ya pagado · hace…»)', async () => {
    const pending = qrService();
    await expect(pending.svc.qrChargeForClient('pay-tok')).resolves.toMatchObject({ status: 'PENDING', paidAt: null });

    const decidedAt = new Date('2026-10-15T21:40:00Z');
    const paid = makeService();
    paid.tx.walletChargeRequest.findUnique.mockResolvedValue(
      request({ walletId: 'w-1', payToken: 'pay-tok', status: 'ACCEPTED', decidedAt }),
    );
    await expect(paid.svc.qrChargeForClient('pay-tok')).resolves.toMatchObject({
      status: 'ACCEPTED',
      paidAt: decidedAt.toISOString(),
    });
  });

  it('el código del «Pagado» es el del cobro único (el mismo que ve el personal); sin cobro con tarjeta, ninguno', async () => {
    const linked = makeService();
    linked.tx.walletChargeRequest.findUnique.mockResolvedValue(
      request({ walletId: 'w-1', payToken: 'pay-tok', status: 'ACCEPTED', decidedAt: new Date(), linkedPaymentId: '0b8c2f1e-0000-4000-8000-0000000000c1' }),
    );
    await expect(linked.svc.qrChargeForClient('pay-tok')).resolves.toMatchObject({ code: '0C1' });
    const alone = qrService();
    await expect(alone.svc.qrChargeForClient('pay-tok')).resolves.toMatchObject({ code: null });
  });

  it('pagado desde /s: la respuesta trae el código del cobro único (la página no lo tenía antes de pagar)', async () => {
    const linked = qrService();
    // La consulta del cobro por su QR (la de antes de pagar) trae el cobro con tarjeta enlazado;
    // el cierre del enlace dentro de la transacción se prueba en la integración (cobro-unico.int.spec).
    linked.tx.walletChargeRequest.findUnique.mockResolvedValueOnce(
      request({ walletId: null, payToken: 'pay-tok', linkedPaymentId: '0b8c2f1e-0000-4000-8000-0000000000c1' }),
    );
    await expect(linked.svc.payQrCharge('pay-tok', 'w-1')).resolves.toMatchObject({ code: '0C1' });
    const alone = qrService();
    await expect(alone.svc.payQrCharge('pay-tok', 'w-1')).resolves.toMatchObject({ code: null });
  });

  it('«Aviso en cada cobro»: sale después de cobrar y, aunque falle, el cobro queda hecho; sin cobro, no sale', async () => {
    const made = qrService();
    const alerts = { chargePaid: vi.fn(() => { throw new Error('servicio de avisos roto'); }) };
    const svc = new WalletChargesService(made.prisma as never, made.audit as never, { get: vi.fn() } as never, made.totp as never, undefined, alerts as never);
    await expect(svc.payQrCharge('pay-tok', 'w-1')).resolves.toBeDefined();
    expect(alerts.chargePaid).toHaveBeenCalledWith('req-1');
    // El aviso, cuando el cobro ya está apuntado (después de la transacción).
    expect(made.tx.walletChargeRequest.updateMany.mock.invocationCallOrder.at(-1)!).toBeLessThan(alerts.chargePaid.mock.invocationCallOrder[0]!);

    const canceled = qrService();
    const quiet = { chargePaid: vi.fn() };
    const svc2 = new WalletChargesService(canceled.prisma as never, canceled.audit as never, { get: vi.fn() } as never, canceled.totp as never, undefined, quiet as never);
    canceled.tx.walletChargeRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(svc2.payQrCharge('pay-tok', 'w-1')).rejects.toThrow(/ya no está pendiente/);
    expect(quiet.chargePaid).not.toHaveBeenCalled();
  });

  it('si la chica lo canceló mientras el cliente pagaba, no se cobra', async () => {
    const { svc, tx } = qrService();
    tx.walletChargeRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(svc.payQrCharge('pay-tok', 'w-1')).rejects.toThrow(/ya no está pendiente/);
  });

  it('caducado o sin saldo → no se cobra nada', async () => {
    const expired = makeService();
    expired.tx.walletChargeRequest.findUnique.mockResolvedValue(
      request({ walletId: null, payToken: 'pay-tok', expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(expired.svc.payQrCharge('pay-tok', 'w-1')).rejects.toThrow(/ya no está pendiente/);
    expect(expired.tx.walletConsumption.create).not.toHaveBeenCalled();

    const poor = qrService();
    poor.tx.$queryRaw.mockResolvedValueOnce([{ id: 'w-1', balanceCents: 5000, status: 'ACTIVE' }]);
    await expect(poor.svc.payQrCharge('pay-tok', 'w-1')).rejects.toThrow(ConflictException);
    expect(poor.tx.walletConsumption.create).not.toHaveBeenCalled();
  });
});

describe('la página del saldo del cliente', () => {
  it('ya no trae cobros que aceptar: solo saldo, Face ID y movimientos', async () => {
    const { svc } = makeService();
    const state = await svc.clientState('tok');
    expect(state).toMatchObject({ code: 'K7Q-4M2', balanceCents: 30_000, status: 'ACTIVE', hasFaceId: false });
    expect(state).toMatchObject({ hasPin: false, hasCard: false, merged: false, refund: null, cards: [] });
    expect(state).not.toHaveProperty('pending');
  });

  it('con su ficha dada (ISSUED, o ACTIVE de antes) → «Pagar» le dice que también paga con ella', async () => {
    const { svc, tx } = makeService();
    tx.walletCard.findMany.mockResolvedValueOnce([{ number: 417, printedNumber: null }]);
    await expect(svc.clientState('tok')).resolves.toMatchObject({ hasCard: true, fichaNumber: '0417' });
    expect(tx.walletCard.findMany).toHaveBeenCalledWith({
      where: { walletId: 'w-1', status: { in: ['ISSUED', 'ACTIVE'] } },
      select: { number: true, printedNumber: true },
    });
    // El número impreso de fábrica, si lo tiene, es el que se ve en el NFC.
    tx.walletCard.findMany.mockResolvedValueOnce([{ number: 9, printedNumber: '00731' }]);
    await expect(svc.clientState('tok')).resolves.toMatchObject({ fichaNumber: '00731' });
  });

  it('«Me voy» pedido: devolución de lo que queda, a las tarjetas de sus recargas', async () => {
    const { svc, tx } = makeService({ wallet: wallet({ closeRequestedAt: new Date(), pinHash: 'h' }) });
    tx.payment.findMany.mockResolvedValueOnce([
      { amountCents: 30_000, tenantId: 'home', authorizedAt: new Date(), createdAt: new Date(), cardLast4: '4242' },
    ]);
    const state = await svc.clientState('tok');
    expect(state).toMatchObject({
      hasPin: true,
      cards: ['4242'],
      refund: { stage: 'requested', amountCents: 30_000, methods: [] },
    });
  });

  it('devolución a la tarjeta a medias → paso «Aprobado», sin salir aún en movimientos', async () => {
    const { svc, tx } = makeService({ wallet: wallet({ closeRequestedAt: new Date(), balanceCents: 0 }) });
    tx.walletPayout.findMany.mockResolvedValueOnce([
      { amountCents: 30_000, method: 'CARD', status: 'PENDING', tenantId: 'home', createdAt: new Date() },
    ]);
    const state = await svc.clientState('tok');
    expect(state.refund).toMatchObject({ stage: 'approved', amountCents: 30_000, methods: ['CARD'] });
    expect(state.movements.some((m) => m.kind === 'payout')).toBe(false);
    expect(tx.walletPayout.findMany.mock.calls[0]![0]).toMatchObject({
      where: { walletId: 'w-1', status: { in: ['DONE', 'PENDING'] } },
    });
  });

  it('recarga sumada a otro saldo → lo dice (no «has gastado todo»)', async () => {
    const { svc } = makeService({ wallet: wallet({ status: 'DEPLETED', balanceCents: 0, mergedIntoId: 'w-2' }) });
    await expect(svc.clientState('tok')).resolves.toMatchObject({ merged: true, refund: null });
  });

  it('«Me voy» ya no pide nada (el saldo no se devuelve): 409 SALDO_NO_SE_DEVUELVE y no se apunta nada', async () => {
    const { svc, tx, audit } = makeService();
    const err = await svc.requestClose('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      code: 'SALDO_NO_SE_DEVUELVE',
      message: 'El saldo no se devuelve: se guarda para la próxima visita.',
    });
    expect(tx.clientWallet.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('el saldo de un reservado sigue la misma regla (el mismo 409)', async () => {
    const { svc, tx } = makeService();
    tx.reservation.count.mockResolvedValue(1);
    await expect(svc.requestClose('tok')).rejects.toMatchObject({ response: { code: 'SALDO_NO_SE_DEVUELVE' } });
    expect(tx.clientWallet.updateMany).not.toHaveBeenCalled();
  });
});

/** El SQL de una llamada a $queryRaw (con ? en lugar de los valores). */
const sqlOf = (call: unknown[]): string => (call[0] as TemplateStringsArray).join('?');

describe('sumar una recarga al saldo de su Face ID', () => {
  function mergeService(
    o: { open?: Array<{ id: string }>; source?: Record<string, unknown>; target?: Record<string, unknown>; codeTaken?: boolean } = {},
  ) {
    const made = makeService();
    const rows = [
      { id: 'src', tenantId: 'home', walletGroup: 'principal', balanceCents: 8000, status: 'ACTIVE', shortCode: 'AAAAAA', mergedIntoId: null, blockedAt: null, ...o.source },
      { id: 'tgt', tenantId: 'home', walletGroup: 'principal', balanceCents: 0, status: 'DEPLETED', shortCode: 'K7Q4M2', mergedIntoId: null, blockedAt: null, ...o.target },
    ];
    made.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const q = sql.join('?');
      if (q.includes('FROM payments')) return o.open ?? [];
      if (q.includes('"shortCode" = ?')) return o.codeTaken && values[0] === 'K7Q4M2' ? [{ id: 'otro' }] : [];
      return rows;
    });
    return made;
  }

  it('bloquea primero los pagos a medias de la recarga (como el cobro: pago → saldo) y luego los saldos', async () => {
    const { svc, tx } = mergeService();
    await svc.mergeInto('src', 'tgt');
    const sqls = tx.$queryRaw.mock.calls.map(sqlOf);
    expect(sqls[0]).toMatch(/FROM payments[\s\S]*"walletId" = \?::uuid[\s\S]*ORPHAN[\s\S]*FOR UPDATE/);
    expect(sqls[1]).toMatch(/FROM client_wallets[\s\S]*FOR UPDATE/);
  });

  it('con un pago de la recarga a medias no se junta nada', async () => {
    const { svc, tx } = mergeService({ open: [{ id: 'pay-1' }] });
    await expect(svc.mergeInto('src', 'tgt')).rejects.toThrow(/a medias/);
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });

  it('el saldo a 0 se reabre; si su código lo tiene ya otro cliente, con uno nuevo', async () => {
    const { svc, tx } = mergeService({ codeTaken: true });
    expect(await svc.mergeInto('src', 'tgt')).toEqual({ balanceCents: 8000 });
    const targetUpdate = tx.clientWallet.update.mock.calls.find((c) => c[0].where.id === 'tgt')![0];
    // Le entra dinero: un «Me voy» de antes ya no vale (como al recargar).
    expect(targetUpdate.data).toMatchObject({ balanceCents: { increment: 8000 }, status: 'ACTIVE', closeRequestedAt: null });
    expect(targetUpdate.data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(targetUpdate.data.shortCode).not.toBe('K7Q4M2');
    // Si era una recarga pendiente de asignar, deja de estarlo.
    expect(tx.clientWallet.update.mock.calls.find((c) => c[0].where.id === 'src')![0].data).toEqual({
      balanceCents: 0,
      status: 'DEPLETED',
      mergedIntoId: 'tgt',
      pendingAssignAt: null,
    });
  });

  it('la ficha de la recarga pasa al saldo del cliente (si no, al pagar diría «no tiene saldo» y el stock la vería libre)', async () => {
    const { svc, tx } = mergeService();
    tx.walletCard.findMany.mockResolvedValueOnce([{ id: 'card-src' }]).mockResolvedValueOnce([]);
    await svc.mergeInto('src', 'tgt');
    expect(tx.walletCard.findMany.mock.calls[0]![0]).toMatchObject({ where: { walletId: 'src' } });
    expect(tx.walletCard.update).toHaveBeenCalledWith({ where: { id: 'card-src' }, data: { walletId: 'tgt', status: 'ISSUED' } });
  });

  it('un saldo que ya se sumó a otro no recibe recargas', async () => {
    const { svc, tx } = mergeService({ target: { mergedIntoId: 'otro' } });
    await expect(svc.mergeInto('src', 'tgt')).rejects.toThrow(/cerrado/);
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });

  it('un saldo bloqueado por el super-admin no se junta (ni el de la recarga ni el del cliente)', async () => {
    for (const blocked of [{ source: { blockedAt: new Date() } }, { target: { blockedAt: new Date() } }]) {
      const { svc, tx } = mergeService(blocked);
      await expect(svc.mergeInto('src', 'tgt')).rejects.toThrow(/bloqueado/);
      expect(tx.clientWallet.update).not.toHaveBeenCalled();
    }
    // Lo lee de la fila bloqueada (FOR UPDATE), no de una lectura anterior.
    const { svc, tx } = mergeService();
    await svc.mergeInto('src', 'tgt');
    expect(sqlOf(tx.$queryRaw.mock.calls[1]!)).toMatch(/"blockedAt"[\s\S]*FROM client_wallets[\s\S]*FOR UPDATE/);
  });
});

describe('juntar saldos desde la página del saldo: el enlace no prueba que sea suyo', () => {
  function withPin(pinHash: string | null) {
    const made = makeService({ wallet: wallet({ id: 'src', pinHash }) });
    const checkPin = vi.spyOn(made.svc as unknown as { checkPin: () => Promise<void> }, 'checkPin').mockResolvedValue(undefined);
    const mergeInto = vi.spyOn(made.svc, 'mergeInto').mockResolvedValue({ balanceCents: 8000 });
    return { ...made, checkPin, mergeInto };
  }

  it('sin PIN: 403, no se mueve nada (solo lo puede juntar el móvil que pagó la recarga)', async () => {
    const { svc, mergeInto, checkPin } = withPin(null);
    await expect(svc.mergeIntoWithPin('src', 'tgt', '4821')).rejects.toMatchObject({ status: 403, response: { code: 'MERGE_PROOF_REQUIRED' } });
    expect(checkPin).not.toHaveBeenCalled();
    expect(mergeInto).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['12'], ['abcd'], [4821]])('PIN que no son 4 cifras (%s): 400 y no gasta un intento', async (pin) => {
    const { svc, mergeInto, checkPin } = withPin('hash');
    await expect(svc.mergeIntoWithPin('src', 'tgt', pin)).rejects.toMatchObject({ status: 400, response: { code: 'PIN_FORMAT' } });
    expect(checkPin).not.toHaveBeenCalled();
    expect(mergeInto).not.toHaveBeenCalled();
  });

  it('PIN mal puesto: no se junta y el fallo cuenta como cualquier otro', async () => {
    const { svc, mergeInto, checkPin } = withPin('hash');
    checkPin.mockRejectedValueOnce(new ConflictException({ code: 'PIN_WRONG' }));
    await expect(svc.mergeIntoWithPin('src', 'tgt', '0000')).rejects.toMatchObject({ response: { code: 'PIN_WRONG' } });
    expect(checkPin).toHaveBeenCalledWith('src', '0000', { tenantId: 'home', userId: null });
    expect(mergeInto).not.toHaveBeenCalled();
  });

  it('con su PIN, se junta', async () => {
    const { svc, mergeInto } = withPin('hash');
    await expect(svc.mergeIntoWithPin('src', 'tgt', '4821')).resolves.toEqual({ balanceCents: 8000 });
    expect(mergeInto).toHaveBeenCalledWith('src', 'tgt');
  });
});

describe('lo que el cliente no confirma pide el 2FA de quien lo hace', () => {
  it('el dueño no termina una devolución pedida antes sin su código, ni en efectivo ni a la tarjeta', async () => {
    for (const method of ['CASH', 'CARD'] as const) {
      const { svc, totp, tx } = makeService({ wallet: wallet({ closeRequestedAt: new Date() }) });
      await expect(svc.payout(owner, 'w-1', { method })).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
      expect(totp.assertForUser).not.toHaveBeenCalled();
      expect(tx.walletPayout.create).not.toHaveBeenCalled();
    }
  });

  it('el dueño sin 2FA activada: se lo dice, no se hace', async () => {
    const { svc, totp } = makeService({ wallet: wallet({ closeRequestedAt: new Date() }) });
    totp.isEnabled.mockResolvedValue(false);
    await expect(svc.payout(owner, 'w-1', { method: 'CASH' })).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } });
  });

  it('enlace nuevo: con su código y solo el dueño', async () => {
    const { svc, totp, tx } = makeService();
    await expect(svc.relinkWithCode(owner, 'w-1', undefined)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
    await expect(svc.relinkWithCode(manager, 'w-1', '123456')).rejects.toThrow(ForbiddenException);
    expect(totp.assertForUser).not.toHaveBeenCalled();
    await expect(svc.relinkWithCode(owner, 'w-1', '123456')).resolves.toMatchObject({ path: expect.stringContaining('/w/a/') });
    expect(totp.assertForUser).toHaveBeenCalledWith(owner.userId, '123456', expect.stringMatching(/^(wallet-payout|relink):/));
  });

  it('un código malo no deja hacer nada', async () => {
    const { svc, totp, tx } = makeService();
    totp.assertForUser.mockRejectedValue(new ForbiddenException({ code: 'TOTP_INVALID' }));
    await expect(svc.resetPin(manager, 'w-1', '000000')).rejects.toMatchObject({ response: { code: 'TOTP_INVALID' } });
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });
});

describe('el cliente perdió el enlace de su saldo', () => {
  it('el dueño le da uno nuevo y el viejo deja de valer; lo que enseña es un QR de activación de un solo uso (M-2)', async () => {
    const { svc, tx, audit } = makeService();
    const out = await svc.relink(owner, 'w-1');
    const data = tx.clientWallet.update.mock.calls[0]![0].data as { qrToken: string };
    expect(data.qrToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(data.qrToken).not.toBe('tok');
    // Nunca el enlace permanente en la pantalla del dueño: /w/a/<token>, 10 min, una vez.
    expect(out.path).toMatch(/^[/]w[/]a[/][A-Za-z0-9_-]{32}$/);
    expect(out.path).not.toContain(data.qrToken);
    expect(tx.walletActivationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ walletId: 'w-1', via: 'relink', issuedById: owner.userId, venueId: owner.tenantId }),
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.relinked' }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(out.path.slice(5));
  });

  it('solo el dueño, solo saldos abiertos de su grupo', async () => {
    await expect(makeService().svc.relink(manager, 'w-1')).rejects.toThrow(ForbiddenException);
    await expect(makeService({ wallet: wallet({ status: 'REFUNDED' }) }).svc.relink(owner, 'w-1')).rejects.toThrow(
      /cerrado/,
    );
    await expect(makeService({ venueGroup: 'otro' }).svc.relink({ ...owner, tenantId: 'ajeno' }, 'w-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('devolver el saldo al cliente que se va', () => {
  interface PayoutRow {
    id: string;
    walletId: string;
    amountCents: number;
    method: string;
    status: string;
    claimedAt: Date | null;
    createdAt: Date;
    bankReference: string | null;
  }

  /**
   * Saldo y devoluciones con estado: lo que se apunta en el banco suma a lo
   * "registrado" (las devoluciones de las recargas desde que empezó la suya).
   */
  function payoutService(
    o: {
      wallet?: Record<string, unknown>;
      payouts?: PayoutRow[];
      registered?: number;
      threshold?: number;
      /** Lo que entró en efectivo en el saldo (el resto, con tarjeta). */
      cashIn?: number;
      /** Lo ya devuelto en efectivo en las últimas 24 h. */
      cashOutToday?: number;
    } = {},
  ) {
    const made = makeService({ wallet: wallet({ closeRequestedAt: new Date(), ...o.wallet }), threshold: o.threshold });
    const state = {
      wallet: { id: 'w-1', balanceCents: 30_000, status: 'ACTIVE', shortCode: 'K7Q4M2', closeRequestedAt: new Date() as Date | null, ...o.wallet },
      payouts: [...(o.payouts ?? [])],
      registered: o.registered ?? 0,
    };
    const { tx, refunds } = made;
    tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
      const q = sql.join('?');
      if (q.includes('wallet_cash_topups')) {
        const out = o.cashOutToday ?? 0;
        return [{ inCents: BigInt(o.cashIn ?? 0), inWindowCents: BigInt(o.cashIn ?? 0), outCents: BigInt(out), outWindowCents: BigInt(out) }];
      }
      if (q.includes('WITH RECURSIVE')) return [{ id: 'w-1' }];
      if (q.includes('FROM refunds')) return [{ total: BigInt(state.registered) }];
      if (q.includes('"shortCode" = ?')) return [];
      return [{ ...state.wallet }];
    });
    tx.clientWallet.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const b = data.balanceCents as number | { increment: number } | undefined;
      if (typeof b === 'number') state.wallet.balanceCents = b;
      else if (b) state.wallet.balanceCents += b.increment;
      if (data.status) state.wallet.status = data.status as string;
      return {};
    });
    const payoutMock = {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id?: string; status?: string } }) =>
        state.payouts.find((p) => (where.id ? p.id === where.id : p.status === where.status)) ?? null,
      ),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `po-${state.payouts.length + 1}`, createdAt: new Date(), claimedAt: null, bankReference: null, ...data } as PayoutRow;
        state.payouts.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<PayoutRow> }) =>
        Object.assign(state.payouts.find((p) => p.id === where.id)!, data),
      ),
      delete: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
        state.payouts = state.payouts.filter((p) => p.id !== where.id);
        return {};
      }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    Object.assign(tx.walletPayout, payoutMock);
    refunds.registerBankRefund.mockImplementation(async (req: { amountCents: number }) => {
      state.registered += req.amountCents;
      return {};
    });
    tx.payment.findMany.mockResolvedValue([
      { id: 'top-2', availableAmountCents: 20_000 },
      { id: 'top-1', availableAmountCents: 20_000 },
    ]);
    return { ...made, state, payoutMock };
  }

  it('en efectivo (encargado, el cliente pulsó "Me voy"): en una transacción, saldo cerrado y devolución apuntada', async () => {
    const { svc, prisma, state, payoutMock, totp } = payoutService({ cashIn: 30_000 });
    const callsBefore = prisma.acrossVenues.mock.calls.length;
    const out = await svc.payout(manager, 'w-1', { method: 'CASH', totpCode: '123456' });
    expect(out).toEqual({ refundedCents: 30_000, method: 'CASH' });
    // 300 € ≥ 100 € (el umbral por defecto): con su código 2FA.
    expect(totp.assertForUser).toHaveBeenCalledWith('man-1', '123456', expect.stringMatching(/^wallet-payout:/));
    // La lectura previa y UNA transacción que cierra y apunta.
    expect(prisma.acrossVenues.mock.calls.length - callsBefore).toBe(2);
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(payoutMock.create.mock.calls[0]![0]).toMatchObject({
      data: { amountCents: 30_000, method: 'CASH', status: 'DONE', paidByUserId: 'man-1' },
    });
  });

  it('encargado en efectivo desde el umbral del local, sin código: 403 TOTP_REQUIRED y no se toca nada', async () => {
    const { svc, state, payoutMock, totp } = payoutService({ threshold: 30_000, cashIn: 30_000 });
    const err = await svc.payout(manager, 'w-1', { method: 'CASH' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    expect((err as Error).message).toMatch(/Devolver 300,00 € en efectivo: con más de 100,00 €/);
    expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    expect(payoutMock.create).not.toHaveBeenCalled();
    // Sin la app activada, se le dice (no un código que no puede poner).
    totp.isEnabled.mockResolvedValueOnce(false);
    const notEnrolled = await svc.payout(manager, 'w-1', { method: 'CASH' }).catch((e: unknown) => e);
    expect((notEnrolled as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
  });

  it('por debajo del umbral el encargado no pone código; el dueño, siempre', async () => {
    const below = payoutService({ threshold: 30_001, cashIn: 5_000, wallet: { balanceCents: 5_000 } });
    await expect(below.svc.payout(manager, 'w-1', { method: 'CASH' })).resolves.toEqual({ refundedCents: 5_000, method: 'CASH' });
    expect(below.totp.assertForUser).not.toHaveBeenCalled();
    const own = payoutService({ threshold: 0, cashIn: 30_000 });
    await expect(own.svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
    expect(own.totp.assertForUser).toHaveBeenCalledWith(owner.userId, '123456', expect.stringMatching(/^wallet-payout:/));
  });

  it('lo que recepción dejó para el encargado (su tope de la noche): en el panel, con su 2FA aunque sea poco', async () => {
    const left = payoutService({ threshold: 30_001, cashIn: 5_000, wallet: { balanceCents: 5_000 } });
    const raw = left.tx.$queryRaw.getMockImplementation()!;
    left.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...args: unknown[]) =>
      sql.join('?').includes('FROM audit_events') ? [{ found: 1 }] : raw(sql, ...args));
    const err = await left.svc.payout(manager, 'w-1', { method: 'CASH' }).catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    expect((err as Error).message).toMatch(/recepción lo dejó para el encargado/);
    await expect(left.svc.payout(manager, 'w-1', { method: 'CASH', totpCode: '123456' })).resolves.toEqual({ refundedCents: 5_000, method: 'CASH' });
    expect(left.totp.assertForUser).toHaveBeenCalledWith('man-1', '123456', expect.stringMatching(/^wallet-payout:/));
  });

  it('el saldo no se devuelve: sin una devolución pedida antes, nadie la empieza (ni el encargado ni el dueño) y no se toca nada', async () => {
    for (const [who, method] of [[manager, 'CASH'], [owner, 'CASH'], [owner, 'CARD']] as const) {
      const { svc, state, payoutMock, refunds, totp } = payoutService({ wallet: { closeRequestedAt: null }, cashIn: 15_000 });
      const err = await svc.payout(who, 'w-1', { totpCode: '123456', method }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'SALDO_NO_SE_DEVUELVE',
        message: 'El saldo no se devuelve: se guarda para la próxima visita.',
      });
      expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
      expect(payoutMock.create).not.toHaveBeenCalled();
      expect(refunds.registerBankRefund).not.toHaveBeenCalled();
      // Antes del 2FA: no gasta un intento del código.
      expect(totp.assertForUser).not.toHaveBeenCalled();
    }
  });

  it('una recarga entre la lectura y el bloqueo del saldo quita el «Me voy»: con el saldo bloqueado, 409 y no se devuelve nada', async () => {
    for (const [who, method] of [[manager, 'CASH'], [owner, 'CASH'], [owner, 'CARD']] as const) {
      const { svc, state, payoutMock, refunds } = payoutService({ cashIn: 15_000 });
      // La lectura de payout() vio el «Me voy»; la fila bloqueada ya no (la recarga lo quitó).
      state.wallet.closeRequestedAt = null;
      await expect(svc.payout(who, 'w-1', { totpCode: '123456', method })).rejects.toMatchObject({ response: { code: 'SALDO_NO_SE_DEVUELVE' } });
      expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
      expect(payoutMock.create).not.toHaveBeenCalled();
      expect(refunds.registerBankRefund).not.toHaveBeenCalled();
    }
  });

  it('el saldo de un reservado (también anulado por el local) sigue la misma regla', async () => {
    const { svc, tx, state, payoutMock } = payoutService({ wallet: { closeRequestedAt: null }, cashIn: 30_000 });
    tx.reservation.count.mockResolvedValue(1);
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).rejects.toMatchObject({ response: { code: 'SALDO_NO_SE_DEVUELVE' } });
    expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    expect(payoutMock.create).not.toHaveBeenCalled();
  });

  it('una devolución a la tarjeta que quedó a medias (de antes) la termina el dueño aunque no hubiera «Me voy»; el encargado, no', async () => {
    const half = {
      id: 'po-1', walletId: 'w-1', amountCents: 30_000, method: 'CARD', status: 'PENDING',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000), createdAt: new Date(Date.now() - 20 * 60 * 1000), bankReference: null,
    };
    const { svc, state } = payoutService({ wallet: { closeRequestedAt: null, balanceCents: 0 }, payouts: [half] });
    await expect(svc.payout(manager, 'w-1', { method: 'CASH' })).rejects.toThrow(ForbiddenException);
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).resolves.toEqual({ refundedCents: 30_000, method: 'CARD' });
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 30_000 })]);
  });

  it('pedida antes con «Me voy»: el encargado y el dueño la terminan como siempre', async () => {
    const byManager = payoutService({ cashIn: 30_000 });
    await expect(byManager.svc.payout(manager, 'w-1', { method: 'CASH', totpCode: '123456' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
    const byOwner = payoutService({ cashIn: 30_000 });
    await expect(byOwner.svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
  });

  it('a la tarjeta: primero el saldo pasa a una devolución PENDING (saldo abierto a 0), luego el banco y al final se cierra', async () => {
    const { svc, state, refunds } = payoutService();
    const seenAtBank: Array<{ balance: number; status: string; payout: string }> = [];
    refunds.registerBankRefund.mockImplementation(async (req: { amountCents: number }) => {
      seenAtBank.push({ balance: state.wallet.balanceCents, status: state.wallet.status, payout: state.payouts[0]!.status });
      state.registered += req.amountCents;
      return {};
    });
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD', bankReference: 'DEV-9' })).resolves.toEqual({
      refundedCents: 30_000,
      method: 'CARD',
    });
    expect(seenAtBank[0]).toEqual({ balance: 0, status: 'ACTIVE', payout: 'PENDING' });
    expect(refunds.registerBankRefund.mock.calls.map((c) => [c[0].paymentId, c[0].amountCents])).toEqual([
      ['top-2', 20_000],
      ['top-1', 10_000],
    ]);
    expect(refunds.registerBankRefund.mock.calls[0]![2]).toEqual({ walletPayout: true });
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 30_000, method: 'CARD', claimedAt: null })]);
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
  });

  it('a la tarjeta solo el dueño, desde el local de las recargas', async () => {
    const { svc } = makeService({ wallet: wallet({ closeRequestedAt: new Date() }) });
    await expect(svc.payout(manager, 'w-1', { method: 'CARD' })).rejects.toThrow(ForbiddenException);
    // Desde otro local del grupo: en efectivo sí, a la tarjeta no (las recargas son del otro local).
    await expect(svc.payout({ ...owner, tenantId: 'other' }, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow(
      /donde el cliente cargó/,
    );
  });

  it('si una devolución falla, se apunta lo hecho y el resto vuelve al saldo (abierto)', async () => {
    const { svc, state, refunds } = payoutService();
    refunds.registerBankRefund
      .mockImplementationOnce(async (req: { amountCents: number }) => {
        state.registered += req.amountCents;
        return {};
      })
      .mockRejectedValueOnce(new Error('fallo'));
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow(/quedan 100,00 €/);
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 20_000 })]);
    expect(state.wallet).toMatchObject({ balanceCents: 10_000, status: 'ACTIVE' });
  });

  it('si algo falla a mitad, la wallet no se queda congelada: vuelve a abrirse con su saldo', async () => {
    const { svc, state, tx, refunds } = payoutService();
    tx.payment.findMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow('db caída');
    expect(refunds.registerBankRefund).not.toHaveBeenCalled();
    // Nada apuntado: la devolución no queda y el saldo vuelve entero.
    expect(state.payouts).toEqual([]);
    expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
  });

  it('se cayó entre el banco y el cierre: queda PENDING con el importe; otro clic al momento espera, pasado el rato se retoma sin repetir', async () => {
    const { svc, state, prisma, refunds } = payoutService();
    // La transacción del cierre falla (el proceso "se cae" justo ahí).
    const real = prisma.acrossVenues.getMockImplementation()!;
    let calls = 0;
    prisma.acrossVenues.mockImplementation(async (fn: never) => {
      calls += 1;
      if (calls === 5) throw new Error('se cayó');
      return real(fn);
    });
    refunds.registerBankRefund
      .mockImplementationOnce(async (req: { amountCents: number }) => {
        state.registered += req.amountCents;
        return {};
      })
      .mockRejectedValueOnce(new Error('fallo'));
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow('se cayó');
    // Recuperable: el saldo está en la devolución PENDING, no perdido ni gastable.
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'ACTIVE' });
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'PENDING', amountCents: 30_000 })]);
    prisma.acrossVenues.mockImplementation(real);

    // Doble clic / otro intento al momento: no se apunta dos veces.
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow(/Ya se está apuntando/);
    expect(refunds.registerBankRefund).toHaveBeenCalledTimes(2);

    // En efectivo tampoco se "devuelve" otra vez: avisa de la que está a medias.
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).rejects.toThrow(/a medias/);

    // Pasado el rato, se retoma: solo lo que faltaba (10 €) y se cierra.
    state.payouts[0]!.claimedAt = new Date(Date.now() - 10 * 60 * 1000);
    refunds.registerBankRefund.mockClear();
    refunds.registerBankRefund.mockImplementation(async (req: { amountCents: number }) => {
      state.registered += req.amountCents;
      return {};
    });
    await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).resolves.toEqual({ refundedCents: 30_000, method: 'CARD' });
    expect(refunds.registerBankRefund.mock.calls.map((c) => c[0].amountCents)).toEqual([10_000]);
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 30_000 })]);
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
  });

  describe('el efectivo no se convierte en dinero del banco ni al revés', () => {
    it('en efectivo solo lo que entró en efectivo: el resto sigue en el saldo (abierto, con su ficha) para «A la tarjeta»', async () => {
      const { svc, state, payoutMock, tx } = payoutService({ cashIn: 10_000 });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).resolves.toEqual({
        refundedCents: 10_000,
        method: 'CASH',
        remainingCents: 20_000,
      });
      expect(state.wallet).toMatchObject({ balanceCents: 20_000, status: 'ACTIVE' });
      expect(payoutMock.create.mock.calls[0]![0]).toMatchObject({ data: { amountCents: 10_000, method: 'CASH', status: 'DONE' } });
      // La ficha no vuelve al stock: el saldo sigue vivo.
      expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
    });

    it('cargado con tarjeta (p. ej. robada) no sale en efectivo: 409 y no se toca nada', async () => {
      const { svc, state, payoutMock } = payoutService();
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).rejects.toThrow(/entró con tarjeta/);
      expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
      expect(payoutMock.create).not.toHaveBeenCalled();
    });

    it('en efectivo, menos de 1.000 € en 24 h aunque entrara más en efectivo (otras noches)', async () => {
      const big = payoutService({ wallet: { balanceCents: 150_000 }, cashIn: 150_000 });
      await expect(big.svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).resolves.toMatchObject({ refundedCents: 99_999, remainingCents: 50_001 });
      const already = payoutService({ cashIn: 130_000, cashOutToday: 99_999 });
      await expect(already.svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).rejects.toThrow(/ya se le devolvieron 999,99 €/);
    });

    it('a la tarjeta, como mucho el saldo menos el efectivo que sigue en él (recarga 500 con tarjeta, gasta 500, recarga 500 en efectivo)', async () => {
      const { svc, state, refunds } = payoutService({ wallet: { balanceCents: 50_000 }, cashIn: 50_000 });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).rejects.toThrow(/entró en efectivo/);
      expect(refunds.registerBankRefund).not.toHaveBeenCalled();
      expect(state.payouts).toEqual([]);
      expect(state.wallet).toMatchObject({ balanceCents: 50_000 });
    });

    it('a la tarjeta, con parte en efectivo: solo la parte de la tarjeta (el efectivo queda en el saldo)', async () => {
      const { svc, state, refunds } = payoutService({ cashIn: 10_000 });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD' })).resolves.toEqual({ refundedCents: 20_000, method: 'CARD' });
      expect(refunds.registerBankRefund.mock.calls.map((c) => c[0].amountCents)).toEqual([20_000]);
      expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 20_000, method: 'CARD' })]);
      // Los 100 € del efectivo siguen en el saldo, abierto: se devuelven en efectivo.
      expect(state.wallet).toMatchObject({ balanceCents: 10_000, status: 'ACTIVE' });
    });

    it('con una devolución a la tarjeta a medias no se paga en efectivo (aunque el saldo tenga dinero)', async () => {
      const { svc, payoutMock } = payoutService({
        cashIn: 30_000,
        payouts: [{ id: 'po-1', amountCents: 5000, status: 'PENDING', method: 'CARD', claimedAt: new Date(), createdAt: new Date(), bankReference: null }],
      });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH' })).rejects.toThrow(/a medias/);
      expect(payoutMock.create).not.toHaveBeenCalled();
    });
  });

  describe('lo que se devolvería, antes de confirmar (el panel enseña esas cifras, no el saldo entero)', () => {
    const pendingCard = (amountCents: number, claimedAt = new Date()): PayoutRow => ({
      id: 'po-1',
      walletId: 'w-1',
      amountCents,
      status: 'PENDING',
      method: 'CARD',
      claimedAt,
      createdAt: new Date(),
      bankReference: null,
    });

    it('300 € de saldo con 100 € en efectivo: 100 € en efectivo ahora y 200 € a la tarjeta; no apunta nada', async () => {
      const { svc, state, payoutMock, tx } = payoutService({ cashIn: 10_000 });
      await expect(svc.payoutPreview(manager, 'w-1')).resolves.toEqual({
        balanceCents: 30_000,
        cashOutCents: 10_000,
        cardRefundCents: 20_000,
        cashLaterCents: 0,
        bitcoinCents: 0,
        pendingCardCents: null,
      });
      expect(payoutMock.create).not.toHaveBeenCalled();
      expect(tx.clientWallet.update).not.toHaveBeenCalled();
      expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    });

    it('todo con tarjeta: nada en efectivo; todo en efectivo: nada a la tarjeta', async () => {
      await expect(payoutService().svc.payoutPreview(owner, 'w-1')).resolves.toMatchObject({ cashOutCents: 0, cardRefundCents: 30_000 });
      await expect(payoutService({ cashIn: 30_000 }).svc.payoutPreview(owner, 'w-1')).resolves.toMatchObject({
        cashOutCents: 30_000,
        cardRefundCents: 0,
        cashLaterCents: 0,
      });
    });

    it('el tope de 1.000 € en 24 h: lo que hoy no sale en efectivo queda para más tarde (en efectivo, no a la tarjeta)', async () => {
      const big = payoutService({ wallet: { balanceCents: 150_000 }, cashIn: 150_000 });
      await expect(big.svc.payoutPreview(owner, 'w-1')).resolves.toMatchObject({
        cashOutCents: 99_999,
        cardRefundCents: 0,
        cashLaterCents: 50_001,
      });
    });

    it('con una devolución a la tarjeta a medias: en efectivo nada y «A la tarjeta» termina la que quedó', async () => {
      const { svc } = payoutService({ cashIn: 30_000, payouts: [pendingCard(5_000)] });
      await expect(svc.payoutPreview(owner, 'w-1')).resolves.toMatchObject({
        cashOutCents: 0,
        cardRefundCents: 5_000,
        cashLaterCents: 0,
        pendingCardCents: 5_000,
      });
    });

    it('un saldo cerrado no tiene nada que devolver', async () => {
      const { svc } = payoutService({ wallet: { balanceCents: 0, status: 'REFUNDED' }, cashIn: 30_000 });
      await expect(svc.payoutPreview(owner, 'w-1')).resolves.toEqual({
        balanceCents: 0,
        cashOutCents: 0,
        cardRefundCents: 0,
        cashLaterCents: 0,
        bitcoinCents: 0,
        pendingCardCents: null,
      });
    });

    it('solo el encargado o el dueño, y de un saldo de su grupo de locales', async () => {
      await expect(payoutService().svc.payoutPreview(chica, 'w-1')).rejects.toThrow(ForbiddenException);
      const other = makeService({ venueGroup: 'otro-grupo' });
      await expect(other.svc.payoutPreview({ ...owner, tenantId: 'other' }, 'w-1')).rejects.toThrow(NotFoundException);
    });

    it('con la cifra que vio el panel: si en efectivo ya es otra, 409 PAYOUT_AMOUNT_CHANGED y no se toca nada', async () => {
      const { svc, state, payoutMock } = payoutService({ cashIn: 10_000 });
      const err = await svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH', expectedAmountCents: 30_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'PAYOUT_AMOUNT_CHANGED' });
      expect(payoutMock.create).not.toHaveBeenCalled();
      expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CASH', expectedAmountCents: 10_000 })).resolves.toEqual({
        refundedCents: 10_000,
        method: 'CASH',
        remainingCents: 20_000,
      });
    });

    it('a la tarjeta igual: otra cifra → 409 sin devolución PENDING ni nada en el banco', async () => {
      const { svc, state, refunds } = payoutService({ cashIn: 10_000 });
      const err = await svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD', expectedAmountCents: 30_000 }).catch((e: unknown) => e);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'PAYOUT_AMOUNT_CHANGED' });
      expect(state.payouts).toEqual([]);
      expect(refunds.registerBankRefund).not.toHaveBeenCalled();
      expect(state.wallet).toMatchObject({ balanceCents: 30_000 });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD', expectedAmountCents: 20_000 })).resolves.toEqual({
        refundedCents: 20_000,
        method: 'CARD',
      });
    });

    it('retomar la devolución a la tarjeta que quedó a medias: la cifra es la de aquella', async () => {
      const { svc, refunds } = payoutService({
        payouts: [pendingCard(5_000, new Date(Date.now() - 10 * 60 * 1000))],
        wallet: { balanceCents: 25_000 },
      });
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD', expectedAmountCents: 25_000 })).rejects.toThrow(ConflictException);
      expect(refunds.registerBankRefund).not.toHaveBeenCalled();
      await expect(svc.payout(owner, 'w-1', { totpCode: '123456', method: 'CARD', expectedAmountCents: 5_000 })).resolves.toEqual({
        refundedCents: 5_000,
        method: 'CARD',
      });
    });
  });
});

describe('consola del super-admin: local en pausa y saldo bloqueado', () => {
  function qrService() {
    const made = makeService();
    made.tx.walletChargeRequest.findUnique.mockResolvedValue(request({ walletId: null, payToken: 'pay-tok' }));
    made.tx.walletChargeRequest.findFirst.mockResolvedValue(request());
    return made;
  }

  it('local en pausa: la chica no puede hacer un cobro con QR (423) y no se crea nada', async () => {
    const { svc, tx } = makeService();
    tx.venue.findUnique.mockResolvedValueOnce({ pausedAt: new Date(), business: null });
    await expect(svc.createQrCharge(chica, { serviceItemId: 'svc-1' })).rejects.toMatchObject({
      status: 423,
      response: expect.objectContaining({ code: 'VENUE_PAUSED' }),
    });
    expect(tx.walletChargeRequest.create).not.toHaveBeenCalled();
  });

  it('negocio en pausa: un cobro hecho antes tampoco se cobra (423) y no se descuenta nada', async () => {
    const { svc, tx } = qrService();
    tx.venue.findUnique.mockResolvedValueOnce({ pausedAt: null, business: { status: 'PAUSED' } });
    await expect(svc.payQrCharge('pay-tok', 'w-1')).rejects.toMatchObject({ status: 423 });
    expect(tx.walletConsumption.create).not.toHaveBeenCalled();
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });

  it('saldo bloqueado: no paga aunque tenga saldo (409, sin consumo ni descuento)', async () => {
    const { svc, tx } = qrService();
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'w-1', balanceCents: 30_000, status: 'ACTIVE', blockedAt: new Date() }]);
    await expect(svc.payQrCharge('pay-tok', 'w-1')).rejects.toThrow(/bloqueado/);
    expect(tx.walletConsumption.create).not.toHaveBeenCalled();
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });
});

describe('formas de cobro del local (Ajustes): saldo y ficha NFC apagados', () => {
  const disabled = (method: string) =>
    expect.objectContaining({ status: 409, response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED', method }) });

  it('pago con saldo apagado: la chica no puede hacer un cobro con QR (409) y no se crea nada', async () => {
    const { svc, tx } = makeService();
    tx.venue.findUnique.mockResolvedValue({ pausedAt: null, business: null, paymentMethods: { wallet: false } });
    await expect(svc.createQrCharge(chica, { serviceItemId: 'svc-1' })).rejects.toEqual(disabled('wallet'));
    expect(tx.walletChargeRequest.create).not.toHaveBeenCalled();
  });

  it('pago con saldo apagado después de hacer el QR: el cliente ya no lo paga (409, sin descuento)', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findUnique.mockResolvedValue(request({ walletId: null, payToken: 'pay-tok' }));
    tx.venue.findUnique.mockResolvedValue({ pausedAt: null, business: null, paymentMethods: { wallet: false } });
    await expect(svc.payQrCharge('pay-tok', 'w-1')).rejects.toEqual(disabled('wallet'));
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
  });

  it('ficha NFC apagada: ni leerla, ni grabar una nueva, ni pagar con ella (con el código sí se sigue)', async () => {
    const { svc, tx } = makeService();
    tx.venue.findUnique.mockResolvedValue({ pausedAt: null, business: null, paymentMethods: { nfc: false } });
    await expect(svc.lookupCard('t-1', { card: 'A'.repeat(22) })).rejects.toEqual(disabled('nfc'));
    await expect(svc.issueCard(chica)).rejects.toEqual(disabled('nfc'));
    tx.walletChargeRequest.findFirst.mockResolvedValue(request());
    await expect(
      svc.payQrChargeWithPin(chica, 'req-1', { card: 'A'.repeat(22), uid: null, pin: '1234' }),
    ).rejects.toEqual(disabled('nfc'));
  });
});


describe('el PAGADO de quien cobra con el saldo: solo datos que el API tiene', () => {
  const paid = () => request({ requestedByUserId: 'op-1', status: 'ACCEPTED', consumptionId: 'cons-1' });

  it('pagado: el código del saldo tapado («K7Q-•••»), nunca entero, y lo que le queda', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(paid());
    const view = await svc.getRequest(chica, 'req-1');
    expect(view).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 30_000, walletCodeHint: 'K7Q-•••' });
    expect(JSON.stringify(view)).not.toContain('K7Q4M2');
    // Sin ficha en la consulta (el sondeo), no hay número de ficha.
    expect(view).not.toHaveProperty('fichaNumber');
  });

  it('pagado con ficha: su número impreso, buscado por su token y del mismo saldo', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(paid());
    const view = await svc.getRequest(chica, 'req-1', { cardToken: 'tok-ficha' });
    expect(view).toMatchObject({ fichaNumber: '1013' });
    expect(tx.walletCard.findFirst).toHaveBeenCalledWith({ where: { token: 'tok-ficha', walletId: 'w-1' }, select: { printedNumber: true } });
  });

  it('ficha sin número impreso: no se enseña ninguno (nada inventado)', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(paid());
    tx.walletCard.findFirst.mockResolvedValue({ printedNumber: null });
    await expect(svc.getRequest(chica, 'req-1', { cardToken: 'tok-ficha' })).resolves.not.toHaveProperty('fichaNumber');
  });

  it('sin pagar: ni código ni ficha', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValue(request({ requestedByUserId: 'op-1' }));
    const view = await svc.getRequest(chica, 'req-1', { cardToken: 'tok-ficha' });
    expect(view).not.toHaveProperty('walletCodeHint');
    expect(view).not.toHaveProperty('fichaNumber');
  });
});
