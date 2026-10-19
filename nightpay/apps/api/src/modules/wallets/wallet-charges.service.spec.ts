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
    clientWallet: {
      findFirst: vi.fn().mockResolvedValue(w),
      findUnique: vi.fn().mockResolvedValue(w),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletChargeRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'req-new', status: 'PENDING', ...data })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletConsumption: {
      create: vi.fn().mockResolvedValue({ id: 'cons-1' }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    operatorEarning: { create: vi.fn().mockResolvedValue({}) },
    walletPayout: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    walletPasskey: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    walletCard: { count: vi.fn().mockResolvedValue(0) },
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ role: 'OPERATOR', commissionBps: null, displayName: 'Lola' }),
    },
    venue: { findUnique: vi.fn().mockResolvedValue({ operatorCommissionDefaults: { CHICA_SERVICE: 9000 } }) },
    // La fila bloqueada (FOR UPDATE) refleja la wallet de la prueba.
    $queryRaw: vi
      .fn()
      .mockResolvedValue(w ? [{ id: w.id, balanceCents: w.balanceCents, status: w.status }] : []),
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
    const out = await svc.createQrCharge(chica, { serviceItemId: 'svc-1' });
    expect(out).toMatchObject({ status: 'PENDING', amountCents: 10_000, serviceName: '30 min' });
    expect(out.payToken.length).toBeGreaterThanOrEqual(32);
    expect(tx.walletChargeRequest.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', walletId: null, requestedByUserId: 'op-1', category: 'CHICA_SERVICE' },
    });
  });

  it('la chica no puede cobrar barra con importe libre', async () => {
    const { svc } = makeService();
    await expect(svc.createQrCharge(chica, { amountCents: 1000, category: 'VENUE_BAR' })).rejects.toThrow(/tus servicios/);
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
    expect(state).toMatchObject({ hasPin: false, merged: false, refund: null, cards: [] });
    expect(state).not.toHaveProperty('pending');
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

  it('"me voy" se apunta una sola vez', async () => {
    const { svc, tx, audit } = makeService();
    await svc.requestClose('tok');
    expect(tx.clientWallet.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'w-1', closeRequestedAt: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.close_requested' }));
    // Pulsarlo otra vez no apunta nada nuevo.
    tx.clientWallet.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.requestClose('tok');
    expect(audit.log).toHaveBeenCalledTimes(1);
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
    expect(targetUpdate.data).toMatchObject({ balanceCents: { increment: 8000 }, status: 'ACTIVE' });
    expect(targetUpdate.data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(targetUpdate.data.shortCode).not.toBe('K7Q4M2');
    expect(tx.clientWallet.update.mock.calls.find((c) => c[0].where.id === 'src')![0].data).toEqual({
      balanceCents: 0,
      status: 'DEPLETED',
      mergedIntoId: 'tgt',
    });
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

describe('el cliente perdió el enlace de su saldo', () => {
  it('el dueño le da uno nuevo y el viejo deja de valer', async () => {
    const { svc, tx, audit } = makeService();
    const out = await svc.relink(owner, 'w-1');
    expect(out.path).toMatch(/^\/w\/[A-Za-z0-9_-]{24}$/);
    const data = tx.clientWallet.update.mock.calls[0]![0].data as { qrToken: string };
    expect(out.path).toBe(`/w/${data.qrToken}`);
    expect(data.qrToken).not.toBe('tok');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.relinked' }));
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
    o: { wallet?: Record<string, unknown>; payouts?: PayoutRow[]; registered?: number; threshold?: number } = {},
  ) {
    const made = makeService({ wallet: wallet({ closeRequestedAt: new Date(), ...o.wallet }), threshold: o.threshold });
    const state = {
      wallet: { id: 'w-1', balanceCents: 30_000, status: 'ACTIVE', shortCode: 'K7Q4M2', ...o.wallet },
      payouts: [...(o.payouts ?? [])],
      registered: o.registered ?? 0,
    };
    const { tx, refunds } = made;
    tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
      const q = sql.join('?');
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
    const { svc, prisma, state, payoutMock, totp } = payoutService();
    const callsBefore = prisma.acrossVenues.mock.calls.length;
    const out = await svc.payout(manager, 'w-1', { method: 'CASH', totpCode: '123456' });
    expect(out).toEqual({ refundedCents: 30_000, method: 'CASH' });
    // 300 € ≥ 100 € (el umbral por defecto): con su código 2FA.
    expect(totp.assertForUser).toHaveBeenCalledWith('man-1', '123456');
    // La lectura previa y UNA transacción que cierra y apunta.
    expect(prisma.acrossVenues.mock.calls.length - callsBefore).toBe(2);
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(payoutMock.create.mock.calls[0]![0]).toMatchObject({
      data: { amountCents: 30_000, method: 'CASH', status: 'DONE', paidByUserId: 'man-1' },
    });
  });

  it('encargado en efectivo desde el umbral del local, sin código: 403 TOTP_REQUIRED y no se toca nada', async () => {
    const { svc, state, payoutMock, totp } = payoutService({ threshold: 30_000 });
    const err = await svc.payout(manager, 'w-1', { method: 'CASH' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    expect((err as Error).message).toMatch(/Devolver 300,00 € en efectivo: desde 300,00 €/);
    expect(state.wallet).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    expect(payoutMock.create).not.toHaveBeenCalled();
    // Sin la app activada, se le dice (no un código que no puede poner).
    totp.isEnabled.mockResolvedValueOnce(false);
    const notEnrolled = await svc.payout(manager, 'w-1', { method: 'CASH' }).catch((e: unknown) => e);
    expect((notEnrolled as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
  });

  it('por debajo del umbral el encargado no pone código; el dueño nunca', async () => {
    const below = payoutService({ threshold: 30_001 });
    await expect(below.svc.payout(manager, 'w-1', { method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
    expect(below.totp.assertForUser).not.toHaveBeenCalled();
    const own = payoutService({ threshold: 0 });
    await expect(own.svc.payout(owner, 'w-1', { method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
    expect(own.totp.assertForUser).not.toHaveBeenCalled();
    expect(own.totp.isEnabled).not.toHaveBeenCalled();
  });

  it('el encargado no devuelve sin el "Me voy" del cliente; el dueño sí', async () => {
    const { svc, tx } = makeService();
    await expect(svc.payout(manager, 'w-1', { method: 'CASH' })).rejects.toThrow(/Me voy/);
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
    const ok = payoutService({ wallet: { closeRequestedAt: null } });
    await expect(ok.svc.payout(owner, 'w-1', { method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
  });

  it('a la tarjeta: primero el saldo pasa a una devolución PENDING (saldo abierto a 0), luego el banco y al final se cierra', async () => {
    const { svc, state, refunds } = payoutService();
    const seenAtBank: Array<{ balance: number; status: string; payout: string }> = [];
    refunds.registerBankRefund.mockImplementation(async (req: { amountCents: number }) => {
      seenAtBank.push({ balance: state.wallet.balanceCents, status: state.wallet.status, payout: state.payouts[0]!.status });
      state.registered += req.amountCents;
      return {};
    });
    await expect(svc.payout(owner, 'w-1', { method: 'CARD', bankReference: 'DEV-9' })).resolves.toEqual({
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
    await expect(svc.payout({ ...owner, tenantId: 'other' }, 'w-1', { method: 'CARD' })).rejects.toThrow(
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
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow(/quedan 100,00 €/);
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 20_000 })]);
    expect(state.wallet).toMatchObject({ balanceCents: 10_000, status: 'ACTIVE' });
  });

  it('si algo falla a mitad, la wallet no se queda congelada: vuelve a abrirse con su saldo', async () => {
    const { svc, state, tx, refunds } = payoutService();
    tx.payment.findMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow('db caída');
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
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow('se cayó');
    // Recuperable: el saldo está en la devolución PENDING, no perdido ni gastable.
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'ACTIVE' });
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'PENDING', amountCents: 30_000 })]);
    prisma.acrossVenues.mockImplementation(real);

    // Doble clic / otro intento al momento: no se apunta dos veces.
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow(/Ya se está apuntando/);
    expect(refunds.registerBankRefund).toHaveBeenCalledTimes(2);

    // En efectivo tampoco se "devuelve" otra vez: avisa de la que está a medias.
    await expect(svc.payout(owner, 'w-1', { method: 'CASH' })).rejects.toThrow(/a medias/);

    // Pasado el rato, se retoma: solo lo que faltaba (10 €) y se cierra.
    state.payouts[0]!.claimedAt = new Date(Date.now() - 10 * 60 * 1000);
    refunds.registerBankRefund.mockClear();
    refunds.registerBankRefund.mockImplementation(async (req: { amountCents: number }) => {
      state.registered += req.amountCents;
      return {};
    });
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).resolves.toEqual({ refundedCents: 30_000, method: 'CARD' });
    expect(refunds.registerBankRefund.mock.calls.map((c) => c[0].amountCents)).toEqual([10_000]);
    expect(state.payouts).toEqual([expect.objectContaining({ status: 'DONE', amountCents: 30_000 })]);
    expect(state.wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
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
