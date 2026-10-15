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

function makeService(opts: { wallet?: ReturnType<typeof wallet> | null; venueGroup?: string | null } = {}) {
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
      findUnique: vi.fn().mockResolvedValue({ name: 'Local Centro', walletGroup: opts.venueGroup === undefined ? 'principal' : opts.venueGroup }),
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
  const svc = new WalletChargesService(prisma as never, audit as never, moduleRef as never);
  return { svc, tx, prisma, refunds, audit };
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
    expect(state).not.toHaveProperty('pending');
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
  function mergeService(o: { open?: Array<{ id: string }>; target?: Record<string, unknown>; codeTaken?: boolean } = {}) {
    const made = makeService();
    const rows = [
      { id: 'src', tenantId: 'home', walletGroup: 'principal', balanceCents: 8000, status: 'ACTIVE', shortCode: 'AAAAAA', mergedIntoId: null },
      { id: 'tgt', tenantId: 'home', walletGroup: 'principal', balanceCents: 0, status: 'DEPLETED', shortCode: 'K7Q4M2', mergedIntoId: null, ...o.target },
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
  it('en efectivo (encargado, el cliente pulsó "Me voy"): todo el saldo, wallet cerrada y apuntado', async () => {
    const { svc, tx } = makeService({ wallet: wallet({ closeRequestedAt: new Date() }) });
    const out = await svc.payout(manager, 'w-1', { method: 'CASH' });
    expect(out).toEqual({ refundedCents: 30_000, method: 'CASH' });
    expect(tx.clientWallet.update).toHaveBeenLastCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: 0, status: 'REFUNDED' },
    });
    expect(tx.walletPayout.create.mock.calls[0]![0]).toMatchObject({
      data: { amountCents: 30_000, method: 'CASH', paidByUserId: 'man-1' },
    });
  });

  it('el encargado no devuelve sin el "Me voy" del cliente; el dueño sí', async () => {
    const { svc, tx } = makeService();
    await expect(svc.payout(manager, 'w-1', { method: 'CASH' })).rejects.toThrow(/Me voy/);
    expect(tx.clientWallet.update).not.toHaveBeenCalled();
    await expect(svc.payout(owner, 'w-1', { method: 'CASH' })).resolves.toEqual({ refundedCents: 30_000, method: 'CASH' });
  });

  it('si algo falla a mitad, la wallet no se queda congelada: vuelve a abrirse con su saldo', async () => {
    const { svc, tx, refunds } = makeService();
    tx.payment.findMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow('db caída');
    expect(refunds.registerBankRefund).not.toHaveBeenCalled();
    expect(tx.clientWallet.update).toHaveBeenLastCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: 30_000, status: 'ACTIVE' },
    });
  });

  it('a la tarjeta (dueño): se reparte entre las recargas como devoluciones de BBVA', async () => {
    const { svc, tx, refunds } = makeService();
    tx.payment.findMany.mockResolvedValueOnce([
      { id: 'top-2', availableAmountCents: 20_000 },
      { id: 'top-1', availableAmountCents: 20_000 },
    ]);
    await svc.payout(owner, 'w-1', { method: 'CARD', bankReference: 'DEV-9' });
    expect(refunds.registerBankRefund.mock.calls.map((c) => [c[0].paymentId, c[0].amountCents])).toEqual([
      ['top-2', 20_000],
      ['top-1', 10_000],
    ]);
    expect(refunds.registerBankRefund.mock.calls[0]![2]).toEqual({ walletPayout: true });
  });

  it('a la tarjeta solo el dueño; si una devolución falla, queda abierto el resto', async () => {
    const { svc } = makeService({ wallet: wallet({ closeRequestedAt: new Date() }) });
    await expect(svc.payout(manager, 'w-1', { method: 'CARD' })).rejects.toThrow(ForbiddenException);
    // Desde otro local del grupo: en efectivo sí, a la tarjeta no (las recargas son del otro local).
    await expect(svc.payout({ ...owner, tenantId: 'other' }, 'w-1', { method: 'CARD' })).rejects.toThrow(
      /donde el cliente cargó/,
    );

    const partial = makeService();
    partial.tx.payment.findMany.mockResolvedValueOnce([
      { id: 'top-2', availableAmountCents: 20_000 },
      { id: 'top-1', availableAmountCents: 20_000 },
    ]);
    partial.refunds.registerBankRefund.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('fallo'));
    await expect(partial.svc.payout(owner, 'w-1', { method: 'CARD' })).rejects.toThrow(/quedan 100,00 €/);
    expect(partial.tx.clientWallet.update).toHaveBeenLastCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: 10_000, status: 'ACTIVE' },
    });
  });
});
