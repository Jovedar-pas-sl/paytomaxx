// Integración (Postgres real, FORCE RLS, TENANCY_UNSCOPED_QUERIES=throw): recepción y fichas.
//  - Recarga en efectivo → saldo sumado al momento y efectivo que ENTRA en la caja de la noche
//    (esperado = fondo + recargas − salidas), en el Z congelado y en los totales del periodo.
//  - Recepción en el datáfono: recarga en efectivo, ficha dada y PIN del cliente, sin persona.
//  - Stock de fichas: preparar → dar → «Me voy» (vuelve al stock) → perdida; resumen por noche.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { posReference } from '../../src/modules/pos-device/paytef';
import { PosDeviceReceptionService } from '../../src/modules/pos-device/pos-device-reception.service';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import type { PosSaleProver } from '../../src/modules/pos-device/pos-sale-proof';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { verifyPin } from '../../src/modules/wallets/wallet-pin';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const config = { get: () => undefined, getOrThrow: () => undefined };
const reports = new ReportsService(prisma);
const incidents = new IncidentsService(prisma, audit as never);
const checks = new CloseCheckService(prisma, incidents, config as never);
const nights = new NightsService(prisma, reports, audit as never, checks);
// Las noches de la prueba se abren «ahora»: entre las 08:00 y las 11:00 el cierre automático las cerraría.
vi.spyOn(nights as unknown as { safeAutoClose(tenantId: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
const period = new PeriodReportsService(prisma);
const cash = new CashTopUpService(prisma, audit as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never, {} as never);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsCreated: { inc: vi.fn() }, paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  {} as never,
  {} as never,
  {} as never,
);
// Como si Paytef confirmara la venta (sin su prueba no se suma: datafono-prueba-topes.int.spec.ts).
const paytefConfirms: PosSaleProver = {
  prove: (claim) => Promise.resolve({ kind: 'confirmed', amountCents: claim.amountCents, currency: 'EUR' }),
};
const pos = new PosDeviceService(prisma, payments, audit as never, cls as never, paytefConfirms);
const reception = new PosDeviceReceptionService(prisma, payments, cash, audit as never, cls as never);

/** Una petición de ese local (como tras AuthGuard o DeviceGuard). */
function inVenue<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}

const r = randomUUID().slice(0, 6);
let k = 0;
const key = () => `recepcion-${r}-${(k += 1)}`;

interface Local {
  id: string;
  owner: string;
  manager: string;
  waiter: string;
  term: string;
  term2: string;
}

let sala: Local;
let norte: Local;

async function seedLocal(tag: string, group: string): Promise<Local> {
  return seed(async (tx) => {
    const id = (await tx.venue.create({ data: { name: `Local ${tag}`, slug: `rf-${tag}-${r}`, walletGroup: group } })).id;
    const user = (role: 'OWNER' | 'MANAGER' | 'WAITER') =>
      tx.user.create({ data: { tenantId: id, email: `${role.toLowerCase()}-${tag}-${r}@x.es`, passwordHash: 'x', role } as never });
    const owner = (await user('OWNER')).id;
    const manager = (await user('MANAGER')).id;
    const waiter = (await user('WAITER')).id;
    const term = (await tx.terminal.create({ data: { tenantId: id, externalId: `REC-${tag}-${r}`, label: `Recepción ${tag}` } })).id;
    const term2 = (await tx.terminal.create({ data: { tenantId: id, externalId: `BAR-${tag}-${r}`, label: `Barra ${tag}` } })).id;
    return { id, owner, manager, waiter, term, term2 };
  });
}

const managerOf = (l: Local) => ({ userId: l.manager, role: 'MANAGER' });
const balanceOf = async (walletId: string) =>
  (await seed((tx) => tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true, status: true } })))!;

beforeAll(async () => {
  await prisma.onModuleInit();
  sala = await seedLocal('sala', `grf-${r}`);
  norte = await seedLocal('norte', `grf-${r}`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recarga en efectivo y caja de la noche (Postgres real)', () => {
  it('saldo nuevo en efectivo: sumado al momento; el mismo botón otra vez no carga dos veces', async () => {
    const body = { amountCents: 5_000, idempotencyKey: key(), wallet: { create: true as const } };
    const out = await inVenue(sala.id, () => cash.topUp(sala.id, managerOf(sala), body));
    expect(out).toMatchObject({ amountCents: 5_000, balanceCents: 5_000, createdWallet: true, replayed: false });
    expect(await balanceOf(out.walletId)).toEqual({ balanceCents: 5_000, status: 'ACTIVE' });
    const again = await inVenue(sala.id, () => cash.topUp(sala.id, managerOf(sala), body));
    expect(again).toMatchObject({ topUpId: out.topUpId, replayed: true });
    expect(await balanceOf(out.walletId)).toMatchObject({ balanceCents: 5_000 });
    expect(await seed((tx) => tx.walletCashTopUp.count({ where: { walletId: out.walletId } }))).toBe(1);
    // Dos a la vez con la misma clave: una sola recarga.
    const twin = { amountCents: 1_000, idempotencyKey: key(), wallet: { code: out.code } };
    await Promise.allSettled([
      inVenue(sala.id, () => cash.topUp(sala.id, managerOf(sala), twin)),
      inVenue(sala.id, () => cash.topUp(sala.id, managerOf(sala), twin)),
    ]);
    expect(await balanceOf(out.walletId)).toMatchObject({ balanceCents: 6_000 });
  });

  it('camarero sin permiso, efectivo apagado o datáfono sin permiso: no se cobra nada', async () => {
    const body = () => ({ amountCents: 1_000, idempotencyKey: key(), wallet: { create: true as const } });
    await expect(inVenue(sala.id, () => cash.topUp(sala.id, { userId: sala.waiter, role: 'WAITER' }, body()))).rejects.toThrow(
      /no te deja cobrar recargas en efectivo/,
    );
    await expect(inVenue(sala.id, () => cash.topUp(sala.id, { terminalId: sala.term }, body()))).rejects.toThrow(/Datáfonos/);
    await seed((tx) => tx.venue.update({ where: { id: norte.id }, data: { paymentMethods: { cashTopUp: false } } }));
    await expect(inVenue(norte.id, () => cash.topUp(norte.id, managerOf(norte), body()))).rejects.toThrow(/recargas en efectivo/);
    await seed((tx) => tx.venue.update({ where: { id: norte.id }, data: { paymentMethods: {} } }));
    expect(await seed((tx) => tx.walletCashTopUp.count({ where: { tenantId: norte.id } }))).toBe(0);
  });

  it('noche: fondo 100 € + recargas en efectivo 80 € − devuelto en efectivo 20 € = 160 € en la caja; al Z y a los totales', async () => {
    // Otra noche limpia en Norte: la caja cuenta desde que se abre.
    await seed((tx) =>
      tx.venue.update({ where: { id: norte.id }, data: { staffPermissions: { roles: { DEVICE: { cashTopUp: true } } } } }),
    );
    const night = await inVenue(norte.id, () => nights.open(norte.id, norte.manager, 10_000));
    const a = await inVenue(norte.id, () =>
      cash.topUp(norte.id, managerOf(norte), { amountCents: 5_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    // El datáfono de recepción (permiso de los datáfonos encendido).
    const b = await inVenue(norte.id, () =>
      cash.topUp(norte.id, { terminalId: norte.term }, { amountCents: 3_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    expect((await seed((tx) => tx.walletCashTopUp.findFirst({ where: { walletId: b.walletId } })))!).toMatchObject({
      takenByUserId: null,
      terminalId: norte.term,
    });
    // «Me voy»: el cliente de la primera se lleva 20 € en efectivo (el resto lo gasta luego).
    await seed((tx) => tx.clientWallet.update({ where: { id: a.walletId }, data: { balanceCents: 2_000, closeRequestedAt: new Date() } }));
    await inVenue(norte.id, () => charges.payout({ userId: norte.manager, role: 'MANAGER', tenantId: norte.id }, a.walletId, { method: 'CASH' }));

    const check = await inVenue(norte.id, () => nights.closeCheck(norte.id));
    expect(check.cash).toEqual({
      openingFloatCents: 10_000,
      cashInCents: 8_000,
      walletCashTopUpsCount: 2,
      walletCashTopUpsCents: 8_000,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 2_000,
      chicaCashPayoutsCount: 0,
      chicaCashPayoutsCents: 0,
      cashOutCents: 2_000,
      expectedCents: 16_000,
    });
    const efectivo = check.steps.find((s) => s.key === 'efectivo')!;
    expect(efectivo).toMatchObject({ status: 'block', count: 3 });
    expect(efectivo.detail).toContain('debería haber 160,00 €');

    const closed = await inVenue(norte.id, () =>
      nights.close(norte.id, { userId: norte.manager, role: 'MANAGER' }, night.id, { cashCountedCents: 16_000 }),
    );
    expect(closed.z.caja).toMatchObject({ cashInCents: 8_000, walletCashTopUpsCount: 2, walletCashTopUpsCents: 8_000, expectedCents: 16_000, diffCents: 0 });
    // Cobrado = las recargas en efectivo (no hay cobros del banco); neto, menos lo devuelto en efectivo.
    expect(closed.z.summary).toMatchObject({ count: 0, chargedCents: 8_000, walletCashTopUpsCents: 8_000, walletCashPayoutsCents: 2_000, netCents: 6_000 });

    const totals = await period.totals(norte.id, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) });
    expect(totals).toMatchObject({ paymentCount: 0, walletCashTopUpCount: 2, walletCashTopUpCents: 8_000, walletCashPayoutCents: 2_000 });
  });
});

describe('recepción en el datáfono: ficha y PIN sin persona (Postgres real)', () => {
  const recepcion = () => ({ terminalId: sala.term, tenantId: sala.id });

  it('recarga en efectivo del datáfono → ficha en blanco grabada y dada → PIN del cliente; otro datáfono no', async () => {
    await seed((tx) => tx.venue.update({ where: { id: sala.id }, data: { staffPermissions: { roles: { DEVICE: { cashTopUp: true } } } } }));
    const top = await inVenue(sala.id, () =>
      cash.topUp(sala.id, { terminalId: sala.term }, { amountCents: 4_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const { card } = await inVenue(sala.id, () => cards.newStockToken(sala.id, { userId: null, terminalId: sala.term }));
    const linked = await inVenue(sala.id, () =>
      charges.linkCardFromTerminal(recepcion(), { walletId: top.walletId, card, uid: '04:a2:3b:5c:1d:80:aa' }),
    );
    expect(linked).toMatchObject({ walletId: top.walletId, balanceCents: 4_000, hasCard: true, hasPin: false });
    expect(await seed((tx) => tx.walletCard.findUnique({ where: { token: card } }))).toMatchObject({
      status: 'ISSUED', walletId: top.walletId, venueId: sala.id, linkedById: null, uid: '04A23B5C1D80AA',
    });
    await inVenue(sala.id, () => charges.setPinFromTerminal(recepcion(), top.walletId, '4827'));
    const w = (await seed((tx) => tx.clientWallet.findUnique({ where: { id: top.walletId } })))!;
    expect(w.pinSetById).toBeNull();
    expect(await verifyPin('4827', w.pinHash!, process.env.ENCRYPTION_KEK!)).toBe(true);
    // La barra (otro datáfono) no ve ni toca ese saldo.
    await expect(inVenue(sala.id, () => charges.receptionWallet({ terminalId: sala.term2, tenantId: sala.id }, top.walletId))).rejects.toThrow(
      /Saldo no encontrado/,
    );
    // La ficha dice de qué saldo es en la recepción (para recargarlo) sin enseñarlo.
    await expect(inVenue(sala.id, () => charges.lookupCardForReception(sala.id, { card }))).resolves.toMatchObject({
      walletId: top.walletId, hasPin: true, isHomeVenue: true,
    });
    // Y paga con ella + PIN como siempre (lookupCard del personal).
    await expect(inVenue(sala.id, () => charges.lookupCard(sala.id, { card, uid: '04A23B5C1D80AA' }))).resolves.toMatchObject({
      walletId: top.walletId, hasCard: true,
    });
  });
});

describe('recarga con tarjeta en el lector del datáfono (Postgres real)', () => {
  const device = () => ({ terminalId: sala.term, tenantId: sala.id, label: 'Recepción', zone: null, tokenHash: 'x' });
  const approved = (paymentId: string, amountCents: number, op: string, tipAmount?: number) => ({
    approved: true,
    authorisationCode: '047215',
    paytefOperationNumber: op,
    transactionReference: posReference(paymentId),
    requestedAmount: amountCents,
    ...(tipAmount ? { tipAmount } : {}),
    cardInformation: { hiddenCardNumber: '************4242', cardTypeCode: 'VI', isContactless: true },
  });

  it('saldo nuevo: el cobro es del datáfono (sin persona) y al aprobarse se suma; luego ficha y PIN ahí mismo', async () => {
    const sale = await inVenue(sala.id, () =>
      reception.cardTopUp(device(), { amountCents: 6_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const p = (await seed((tx) => tx.payment.findUnique({ where: { id: sale.paymentId } })))!;
    expect(p).toMatchObject({ captureMethod: 'WALLET_TOPUP', createdByUserId: null, terminalId: sala.term, walletId: sale.walletId, status: 'CREATED' });
    expect(await balanceOf(sale.walletId)).toMatchObject({ balanceCents: 0 });

    const out = await inVenue(sala.id, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 6_000, `R${r}1`)));
    expect(out).toMatchObject({ status: 'PAID' });
    expect(await balanceOf(sale.walletId)).toEqual({ balanceCents: 6_000, status: 'ACTIVE' });
    expect((await seed((tx) => tx.payment.findUnique({ where: { id: sale.paymentId } })))!).toMatchObject({
      status: 'AUTHORIZED', posTerminalId: sala.term, provider: 'PAYTEF', tipCents: 0,
    });
    // El mismo datáfono, en sus 15 min: ficha (en blanco, grabada ahora) y el PIN del cliente.
    const { card } = await inVenue(sala.id, () => cards.newStockToken(sala.id, { userId: null, terminalId: sala.term }));
    await inVenue(sala.id, () => charges.linkCardFromTerminal({ terminalId: sala.term, tenantId: sala.id }, { walletId: sale.walletId, card }));
    const view = await inVenue(sala.id, () => charges.setPinFromTerminal({ terminalId: sala.term, tenantId: sala.id }, sale.walletId, '5826'));
    expect(view).toMatchObject({ balanceCents: 6_000, hasCard: true, hasPin: true });
    // Reenviar el mismo resultado (se cortó la red) no suma dos veces.
    await inVenue(sala.id, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 6_000, `R${r}1`)));
    expect(await balanceOf(sale.walletId)).toMatchObject({ balanceCents: 6_000 });
  });

  it('con propina en el lector: no se suma nada y se pide anularla', async () => {
    const sale = await inVenue(sala.id, () =>
      reception.cardTopUp(device(), { amountCents: 2_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const out = await inVenue(sala.id, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 2_000, `R${r}2`, 300)));
    expect(out).toMatchObject({ status: 'MISMATCH' });
    expect(await balanceOf(sale.walletId)).toMatchObject({ balanceCents: 0 });
  });

  it('la recarga del datáfono de recepción no la cobra otro datáfono', async () => {
    const sale = await inVenue(sala.id, () =>
      reception.cardTopUp(device(), { amountCents: 1_500, idempotencyKey: key(), wallet: { create: true } }),
    );
    const barra = { ...device(), terminalId: sala.term2, label: 'Barra' };
    const out = await inVenue(sala.id, () => pos.reportResult(barra, sale.paymentId, approved(sale.paymentId, 1_500, `R${r}3`)));
    expect(out).toMatchObject({ status: 'MISMATCH' });
    expect(await balanceOf(sale.walletId)).toMatchObject({ balanceCents: 0 });
  });
});

describe('stock de fichas: preparar → dar → «Me voy» → perdida (Postgres real)', () => {
  it('el ciclo de vida queda en la ficha y en el resumen de la noche', async () => {
    const by = { userId: sala.manager };
    const night = await inVenue(sala.id, () => nights.open(sala.id, sala.manager));
    // Preparar dos fichas.
    const t1 = (await inVenue(sala.id, () => cards.newStockToken(sala.id, by))).card;
    const t2 = (await inVenue(sala.id, () => cards.newStockToken(sala.id, by))).card;
    expect(await inVenue(sala.id, () => cards.stock(sala.id, by, { card: t1, uid: '04AA000000' + r.replace(/[^0-9a-f]/gi, '0').slice(0, 4) }))).toEqual({
      outcome: 'stocked',
    });
    expect(await inVenue(sala.id, () => cards.stock(sala.id, by, { card: t2 }))).toEqual({ outcome: 'stocked' });
    expect(await inVenue(sala.id, () => cards.stock(sala.id, by, { card: t2 }))).toEqual({ outcome: 'already' });

    // Se da la primera a un saldo recargado en efectivo por el encargado.
    const top = await inVenue(sala.id, () =>
      cash.topUp(sala.id, managerOf(sala), { amountCents: 2_500, idempotencyKey: key(), wallet: { create: true } }),
    );
    await inVenue(sala.id, () => charges.linkCard({ userId: sala.manager, role: 'MANAGER', tenantId: sala.id }, { code: top.code, card: t1 }));
    // Con saldo: «Preparar fichas» la aparta y dice de quién es.
    expect(await inVenue(sala.id, () => cards.stock(sala.id, by, { card: t1 }))).toEqual({
      outcome: 'in-use',
      codeHint: `${top.code.slice(0, 3)}-•••`,
    });

    // «Me voy» en efectivo: la ficha vuelve al stock.
    await seed((tx) => tx.clientWallet.update({ where: { id: top.walletId }, data: { closeRequestedAt: new Date() } }));
    await inVenue(sala.id, () => charges.payout({ userId: sala.manager, role: 'MANAGER', tenantId: sala.id }, top.walletId, { method: 'CASH' }));
    expect(await seed((tx) => tx.walletCard.findUnique({ where: { token: t1 } }))).toMatchObject({ status: 'RETURNED', walletId: null });

    // La segunda se pierde.
    const row2 = (await seed((tx) => tx.walletCard.findUnique({ where: { token: t2 } })))!;
    const lost = await inVenue(sala.id, () => cards.mark({ userId: sala.manager, role: 'MANAGER', tenantId: sala.id }, row2.id, 'lost'));
    expect(lost).toMatchObject({ status: 'LOST' });
    expect(await inVenue(sala.id, () => cards.stock(sala.id, by, { card: t2 }))).toEqual({ outcome: 'lost' });

    // El panel: lista del local (búsqueda por el código grabado) y el resumen de la noche abierta.
    const listed = await inVenue(sala.id, () => cards.list(sala.id, { q: t1.slice(0, 8) }));
    expect(listed).toEqual([expect.objectContaining({ status: 'RETURNED', tokenHint: t1.slice(0, 6) })]);
    const summary = await inVenue(sala.id, () => cards.summary(sala.id));
    // De la noche: t1 entregada y devuelta, t2 perdida; en el stock queda t1 (la del datáfono se dio antes de abrirla).
    expect(summary.nights[0]).toMatchObject({ nightId: night.id, open: true, entregadas: 1, devueltas: 1, perdidas: 1, enStock: 1 });
    // Ahora: en el stock, t1; entregadas, las de las recepciones de antes (no esta noche).
    expect(summary.enStock).toBe(1);

    // Al cerrar, las fichas de la noche quedan congeladas en el Z.
    // Entraron 25 € en efectivo y salieron 25 € («Me voy»): con fondo 0, en la caja 0 €.
    const closed = await inVenue(sala.id, () =>
      nights.close(sala.id, { userId: sala.manager, role: 'MANAGER' }, night.id, {
        openingFloatCents: 0,
        cashCountedCents: 0,
        acknowledged: ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'],
        note: 'prueba de fichas',
      }),
    );
    expect(closed.z.caja).toMatchObject({ walletCashTopUpsCents: 2_500, walletCashPayoutsCents: 2_500, expectedCents: 0, diffCents: 0 });
    expect(closed.z.fichas).toMatchObject({ perdidas: 1, devueltas: 1, enStock: 1 });
    const after = await inVenue(sala.id, () => cards.summary(sala.id));
    expect(after.nights.find((n) => n.nightId === night.id)).toMatchObject({ open: false, perdidas: 1, enStock: 1 });
  });

  it('en la base: solo los estados del ciclo de vida y una ficha dada por saldo', async () => {
    await expect(seed((tx) => tx.walletCard.create({ data: { token: `fichaRaraDeLaPrueba${r}`, status: 'ACTIVE' } }))).rejects.toThrow();
    const top = await inVenue(sala.id, () =>
      cash.topUp(sala.id, managerOf(sala), { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    await seed((tx) => tx.walletCard.create({ data: { token: `fichaUnoDeLaPrueba${r}`, status: 'ISSUED', walletId: top.walletId } }));
    await expect(
      seed((tx) => tx.walletCard.create({ data: { token: `fichaDosDeLaPrueba${r}`, status: 'ISSUED', walletId: top.walletId } })),
    ).rejects.toThrow();
    // Por defecto, una ficha nueva está en el stock.
    expect((await seed((tx) => tx.walletCard.create({ data: { token: `fichaTresDeLaPrueba${r}` } }))).status).toBe('STOCK');
  });
});
