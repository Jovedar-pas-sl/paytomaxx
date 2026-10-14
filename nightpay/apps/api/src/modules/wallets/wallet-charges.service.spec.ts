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

function makeService(opts: { wallet?: ReturnType<typeof wallet> | null; pending?: unknown; venueGroup?: string | null } = {}) {
  const w = opts.wallet === undefined ? wallet() : opts.wallet;
  const tx = {
    clientWallet: {
      findFirst: vi.fn().mockResolvedValue(w),
      findUnique: vi.fn().mockResolvedValue(w),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletChargeRequest: {
      findFirst: vi.fn().mockResolvedValue(opts.pending ?? null),
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

describe('pedir un cobro del saldo', () => {
  it('con un servicio de la carta: precio y categoría del local, espera al cliente', async () => {
    const { svc, tx } = makeService();
    const out = await svc.createRequest(chica, { code: 'K7Q4M2', serviceItemId: 'svc-1' });
    expect(out).toMatchObject({ status: 'PENDING', amountCents: 10_000, serviceName: '30 min' });
    expect(tx.walletChargeRequest.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', walletId: 'w-1', requestedByUserId: 'op-1', category: 'CHICA_SERVICE' },
    });
  });

  it('se comprueba con la wallet bloqueada y los pendientes caducados se cierran antes', async () => {
    const { svc, tx } = makeService();
    await svc.createRequest(chica, { code: 'K7Q4M2', amountCents: 1000 });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.walletChargeRequest.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { walletId: 'w-1', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  });

  it('más de lo que queda o con otro cobro esperando → no', async () => {
    const poor = makeService({ wallet: wallet({ balanceCents: 5000 }) });
    await expect(poor.svc.createRequest(chica, { code: 'K7Q4M2', serviceItemId: 'svc-1' })).rejects.toThrow(
      /no llega/,
    );
    const busy = makeService({ pending: request() });
    await expect(busy.svc.createRequest(chica, { code: 'K7Q4M2', amountCents: 1000 })).rejects.toThrow(
      /otro cobro/,
    );
  });

  it('la chica no puede cobrar barra con importe libre', async () => {
    const { svc } = makeService();
    await expect(
      svc.createRequest(chica, { code: 'K7Q4M2', amountCents: 1000, category: 'VENUE_BAR' }),
    ).rejects.toThrow(/tus servicios/);
  });
});

describe('el cliente acepta en su móvil', () => {
  it('descuenta el saldo, apunta el consumo en el local donde se cobra y la parte de la chica', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValueOnce(request()).mockResolvedValue(null);
    await svc.accept('tok', 'req-1');
    expect(tx.walletConsumption.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', walletId: 'w-1', amountCents: 10_000, providedByUserId: 'op-1', idempotencyKey: 'charge-request:req-1' },
    });
    expect(tx.operatorEarning.create.mock.calls[0]![0]).toMatchObject({
      data: { tenantId: 'other', operatorId: 'op-1', commissionBps: 9000, commissionCents: 9000 },
    });
    // El que acepta un cobro sigue en el local: se le quita el "Me voy".
    expect(tx.clientWallet.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: 20_000, closeRequestedAt: null },
    });
    expect(tx.walletChargeRequest.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'req-1', status: 'PENDING' },
      data: { status: 'ACCEPTED', consumptionId: 'cons-1' },
    });
  });

  it('si la chica lo canceló mientras el cliente aceptaba, no se cobra', async () => {
    const { svc, tx } = makeService();
    tx.walletChargeRequest.findFirst.mockResolvedValueOnce(request()).mockResolvedValue(null);
    tx.walletChargeRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.accept('tok', 'req-1')).rejects.toThrow(/ya no está pendiente/);
  });

  it('caducado o sin saldo → no se cobra nada', async () => {
    const expired = makeService();
    expired.tx.walletChargeRequest.findFirst.mockResolvedValueOnce(request({ expiresAt: new Date(Date.now() - 1) }));
    await expect(expired.svc.accept('tok', 'req-1')).rejects.toThrow(/caducado/);
    expect(expired.tx.walletConsumption.create).not.toHaveBeenCalled();

    const poor = makeService();
    poor.tx.$queryRaw.mockResolvedValueOnce([{ id: 'w-1', balanceCents: 5000, status: 'ACTIVE' }]);
    poor.tx.walletChargeRequest.findFirst.mockResolvedValueOnce(request());
    await expect(poor.svc.accept('tok', 'req-1')).rejects.toThrow(ConflictException);
  });

  it('rechazar y "me voy"', async () => {
    const { svc, tx, audit } = makeService();
    await svc.reject('tok', 'req-1');
    expect(tx.walletChargeRequest.updateMany.mock.calls[0]![0]).toMatchObject({ data: { status: 'REJECTED' } });
    await svc.requestClose('tok');
    expect(tx.clientWallet.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'w-1', closeRequestedAt: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.close_requested' }));
    // Pulsarlo otra vez no apunta nada nuevo.
    tx.clientWallet.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.requestClose('tok');
    expect(audit.log).toHaveBeenCalledTimes(1);
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
