// Integración (Postgres real, np_app y FORCE RLS): reservados, respuestas del
// dueño del 17-nov. Hora de apertura del local (las 48 h y «esta noche hasta
// 2 h antes» cuentan desde ella); el cliente anula con 48 h (pierde la señal,
// lo demás es saldo); el resto en efectivo en la puerta o en recepción (entra
// en la caja de la noche como una recarga en efectivo); el RRPP pierde la
// comisión si el local cambia la fecha o anula; «No vino» solo a las 12:00 del
// día siguiente y el encargado lo deshace.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { madridAt, madridDay } from '../../src/common/time/madrid';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { ReservationsService, type BookingEntry } from '../../src/modules/reservations/reservations.service';
import { ReservationOpsService } from '../../src/modules/reservations/reservation-ops.service';
import { ReservationCatalogService } from '../../src/modules/reservations/reservation-catalog.service';
import { autoNoShowAt, nightOf, nightStart } from '../../src/modules/reservations/reservation-rules';

// La hora, fija a las 12:00 de Madrid de hoy (se lancen cuando se lancen).
const REAL_NOW = Date.now();
const BASE_NOW = madridAt(madridDay(new Date(REAL_NOW)), 12);
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(BASE_NOW);

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
};
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const store = new Map<string, string>();
const redis = {
  set: async (k: string, v: string, ...flags: unknown[]) => {
    if (flags.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  },
  del: async (k: string) => (store.delete(k) ? 1 : 0),
};
const audit = new AuditService(prisma, cls as never);
const cash = new CashTopUpService(prisma, audit, {} as never);
const reservations = new ReservationsService(prisma, payments, redis as never, audit);
const ops = new ReservationOpsService(prisma, audit, reservations, payments, cash);
const catalog = new ReservationCatalogService(prisma, audit, { get: () => 'https://api.prueba.es' } as never);

const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-resv2' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));
const as = <T>(a: { userId: string; tenantId: string; role: string }, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-resv2', tenantId: a.tenantId, userId: a.userId, role: a.role });
    return fn();
  });

const r = randomUUID().slice(0, 6);
let A: string;
let owner: { userId: string; role: 'OWNER'; tenantId: string };
let door: { userId: string; role: 'WAITER'; tenantId: string };
let manager: { userId: string; role: 'MANAGER'; tenantId: string };
let rrppUser: string;
let promoterCode: string;
let pkgId: string;
let orders = 0;
const tonight = () => nightOf(new Date());
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
const code = (err: unknown) => ((err as HttpException).getResponse() as { code?: string }).code;
const message = (err: unknown) => ((err as HttpException).getResponse() as { message?: string }).message;
const resvOf = (id: string) => sys((tx) => tx.reservation.findUniqueOrThrow({ where: { id } }));
const walletOf = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));

async function entry(promoter = false): Promise<BookingEntry> {
  const e = promoter ? await pub(() => reservations.entryByPromoterCode(promoterCode)) : await pub(() => reservations.entryForPanel(A));
  if (!e) throw new Error('sin entrada');
  return e;
}

const book = (e: BookingEntry, nightDate: string) =>
  pub(() => reservations.book(e, { packageId: pkgId, nightDate, customerName: 'Grupo Pérez', customerPhone: '611223344', key: key() }));

async function pay(manageToken: string, kind: 'DEPOSIT' | 'REST' | 'FULL') {
  const started = await pub(() => reservations.startPayment(manageToken, kind, 'es'));
  const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
  orders += 1;
  const order = `RW${r}${String(orders).padStart(4, '0')}`;
  await pub(() => payments.transition(p.id, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: p.id }, data: { provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId: p.id, tenantId: A, provider: 'REDSYS', providerTxId: order, amountCents: p.amountCents, tipCents: 0, claimHash: 'c'.repeat(64) },
    });
  });
  await pub(() => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
  return p;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Cambios', slug: `resv2-${r}`, walletGroup: `gresv2-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: A, externalId: `RW-BAR-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    const user = (role: string, tag: string, post?: string) =>
      tx.user.create({ data: { tenantId: A, email: `${tag}-resv2-${r}@x.es`, passwordHash: 'x', role, ...(post ? { post } : {}) } as never });
    owner = { userId: (await user('OWNER', 'own')).id, role: 'OWNER', tenantId: A };
    door = { userId: (await user('WAITER', 'rec', 'RECEPCION')).id, role: 'WAITER', tenantId: A };
    manager = { userId: (await user('MANAGER', 'enc')).id, role: 'MANAGER', tenantId: A };
    rrppUser = (await user('WAITER', 'rrpp')).id;
    promoterCode = `p2${r}abcdefgh`.slice(0, 12);
    await tx.promoter.create({ data: { tenantId: A, userId: rrppUser, commissionBps: 1000, code: promoterCode } });
  });
  pkgId = (await pub(() => catalog.createPackage(owner, { name: 'Mesa', kind: 'CREDIT', priceCents: 50000, creditCents: 50000, entries: 4, items: [] }))).id;
});

afterEach(() => {
  vi.setSystemTime(BASE_NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe('la hora de apertura', () => {
  it('20:00 de serie; se cambia en el panel y cuenta para «esta noche hasta 2 h antes»', async () => {
    expect((await pub(() => catalog.settings(A))).openTime).toBe('20:00');
    expect((await as(manager, () => catalog.setOpenTime(manager, '23:30'))).openTime).toBe('23:30');
    // A las 21:29 de esta noche aún se reserva (abre a las 23:30); a las 21:31, ya no.
    const open = nightStart(tonight(), 23 * 60 + 30).getTime();
    vi.setSystemTime(new Date(open - 2 * 3600_000 - 60_000));
    await book(await entry(), tonight());
    vi.setSystemTime(new Date(open - 2 * 3600_000 + 60_000));
    const late = await book(await entry(), tonight()).catch((e: unknown) => e);
    expect(message(late)).toBe('Para esta noche se reserva hasta 2 horas antes de abrir');
    await as(manager, () => catalog.setOpenTime(manager, '20:00'));
  });
});

describe('el cliente anula', () => {
  it('sin pagar se cancela; pagada con 48 h pierde la señal y lo demás le queda de saldo; sin 48 h, no', async () => {
    const unpaid = await book(await entry(), plusDays(tonight(), 5));
    await pub(() => reservations.clientCancel(unpaid.manageToken));
    expect((await resvOf(unpaid.id)).status).toBe('CANCELED');

    const paid = await book(await entry(), plusDays(tonight(), 5));
    const p = await pay(paid.manageToken, 'FULL');
    expect((await pub(() => reservations.groupView(paid.manageToken)))?.cancel).toBe('Anular');
    await pub(() => reservations.clientCancel(paid.manageToken));
    expect(await resvOf(paid.id)).toMatchObject({ status: 'CLIENT_CANCELED' });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(35000);
    const lost = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: p.walletId!, idempotencyKey: { startsWith: `resv-cancel:${paid.id}:` } } }));
    expect(lost).toMatchObject({ amountCents: 15000, category: 'VENUE_ENTRY', providedByUserId: owner.userId });
    expect((await pub(() => reservations.groupView(paid.manageToken)))?.saldoHref).toMatch(/^\/w\//);

    const soon = await book(await entry(), plusDays(tonight(), 1));
    await pay(soon.manageToken, 'DEPOSIT');
    const view = await pub(() => reservations.groupView(soon.manageToken));
    expect(view?.cancel).toBeNull();
    expect(view?.cancelBlocked).toBe('Se anula avisando con 48 horas. Si no venís, se queda como «No vino».');
    expect(code(await pub(() => reservations.clientCancel(soon.manageToken)).catch((e: unknown) => e))).toBe('RESERVATION_CANCEL');
  });
});

describe('el resto en efectivo', () => {
  it('en la puerta o en recepción: recarga en efectivo del saldo del grupo (caja de la noche), una vez; la comisión del RRPP con el paquete pagado entero', async () => {
    const res = await book(await entry(true), tonight());
    const dep = await pay(res.manageToken, 'DEPOSIT');
    const quote = await as(door, () => ops.cashQuote(door, res.id));
    expect(quote).toMatchObject({ amountCents: 35000, serviceFeeCents: 0, totalCents: 35000, blocked: null });
    const k = key();
    const view = await as(door, () => ops.payRestCash(door, res.id, { key: k, serviceFeeCents: 0 }));
    expect(view).toMatchObject({ status: 'PAID', paidCents: 50000 });
    await as(door, () => ops.payRestCash(door, res.id, { key: k, serviceFeeCents: 0 })); // repetido: nada
    const tops = await sys((tx) => tx.walletCashTopUp.findMany({ where: { walletId: dep.walletId! } }));
    expect(tops).toHaveLength(1);
    expect(tops[0]).toMatchObject({ amountCents: 35000, takenByUserId: door.userId });
    expect((await walletOf(dep.walletId!)).balanceCents).toBe(50000);
    const link = await sys((tx) => tx.reservationPayment.findFirstOrThrow({ where: { reservationId: res.id, cashTopUpId: { not: null } } }));
    expect(link).toMatchObject({ kind: 'REST', amountCents: 35000, paymentId: null });
    const earnings = await sys((tx) => tx.operatorEarning.findMany({ where: { operatorId: rrppUser } }));
    expect(earnings).toEqual([expect.objectContaining({ paymentId: dep.id, commissionCents: 5000 })]);
    // Ya pagada: la puerta da la llegada.
    expect((await as(door, () => ops.arrive(door, res.id))).status).toBe('ARRIVED');
  });
});

describe('el RRPP pierde la comisión si el local cambia la fecha o anula', () => {
  it('el local cambia la fecha antes de pagarse entero: al pagarse, sin comisión', async () => {
    const before = await sys((tx) => tx.operatorEarning.count({ where: { operatorId: rrppUser } }));
    const res = await book(await entry(true), plusDays(tonight(), 6));
    await pay(res.manageToken, 'DEPOSIT');
    await as(owner, () => ops.venueChangeDate(owner, res.id, plusDays(tonight(), 8)));
    await pay(res.manageToken, 'REST');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', commissionEarnedAt: null });
    expect((await resvOf(res.id)).commissionVoidedAt).not.toBeNull();
    expect(await sys((tx) => tx.operatorEarning.count({ where: { operatorId: rrppUser } }))).toBe(before);
  });

  it('el local anula después de ganarla: sale del reparto (neto 0) y lo pagado queda como saldo del grupo', async () => {
    const res = await book(await entry(true), plusDays(tonight(), 7));
    const p = await pay(res.manageToken, 'FULL');
    const earning = await sys((tx) => tx.operatorEarning.findFirstOrThrow({ where: { operatorId: rrppUser, paymentId: p.id } }));
    expect(earning).toMatchObject({ commissionCents: 5000, reversedCents: 0 });
    const out = await as(owner, () => ops.venueCancel(owner, res.id, 'Cerramos esa noche'));
    expect(out).toMatchObject({ saldoCents: 50000, walletId: p.walletId });
    expect(await sys((tx) => tx.operatorEarning.findUniqueOrThrow({ where: { id: earning.id } }))).toMatchObject({ reversedCents: 5000 });
    expect(await resvOf(res.id)).toMatchObject({ status: 'CANCELED' });
    expect((await resvOf(res.id)).commissionVoidedAt).not.toBeNull();
    // El saldo, entero: el local no lo devuelve ni lo cobra.
    expect((await walletOf(p.walletId!)).balanceCents).toBe(50000);
  });
});

describe('«No vino» a las 12:00 del día siguiente', () => {
  it('antes no; a las 12:00, solo; el encargado lo deshace y apunta la llegada tarde', async () => {
    const res = await book(await entry(), tonight());
    const p = await pay(res.manageToken, 'FULL');
    vi.setSystemTime(new Date(autoNoShowAt(tonight()).getTime() - 60_000));
    expect(await pub(() => ops.autoNoShowDue())).toBe(0);
    vi.setSystemTime(new Date(autoNoShowAt(tonight()).getTime() + 60_000));
    expect(await pub(() => ops.autoNoShowDue())).toBeGreaterThanOrEqual(1);
    expect(await resvOf(res.id)).toMatchObject({ status: 'NO_SHOW', noShowAuto: true });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(35000);
    // Otra vez: nada nuevo.
    expect(await pub(() => ops.autoNoShowDue())).toBe(0);
    // El camarero no lo deshace; el encargado, sí.
    await expect(as(door, () => ops.undoNoShow(door, res.id))).rejects.toThrow('Solo el encargado o el dueño');
    const undone = await as(manager, () => ops.undoNoShow(manager, res.id));
    expect(undone).toMatchObject({ status: 'PAID', noShowAuto: false });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(50000);
    // Vinieron: el encargado apunta la llegada tarde (el camarero, no).
    expect(code(await as(door, () => ops.arrive(door, res.id)).catch((e: unknown) => e))).toBe('RESERVATION_ARRIVAL');
    expect((await as(manager, () => ops.arrive(manager, res.id))).status).toBe('ARRIVED');
  });

  it('deshecho, el repaso (cada 10 min) no lo vuelve a poner; a mano, sí; con otra noche del local, vuelve a contar', async () => {
    const res = await book(await entry(), tonight());
    const p = await pay(res.manageToken, 'FULL');
    const noon = autoNoShowAt(tonight()).getTime();
    vi.setSystemTime(new Date(noon + 60_000));
    await pub(() => ops.autoNoShowDue());
    expect(await resvOf(res.id)).toMatchObject({ status: 'NO_SHOW', noShowAuto: true });
    await as(manager, () => ops.undoNoShow(manager, res.id));
    // La vuelta siguiente: sigue pagada y la señal, en su saldo.
    vi.setSystemTime(new Date(noon + 11 * 60_000));
    await pub(() => ops.autoNoShowDue());
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID' });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(50000);
    // El encargado sí lo puede marcar otra vez a mano.
    expect((await as(manager, () => ops.noShow(manager, res.id))).status).toBe('NO_SHOW');
    expect((await walletOf(p.walletId!)).balanceCents).toBe(35000);
    // Deshecho otra vez y el local le da otra noche: si no vienen, esa noche sí se pone sola.
    await as(manager, () => ops.undoNoShow(manager, res.id));
    const other = tonight();
    await as(manager, () => ops.venueChangeDate(manager, res.id, other));
    vi.setSystemTime(new Date(autoNoShowAt(other).getTime() + 60_000));
    await pub(() => ops.autoNoShowDue());
    expect(await resvOf(res.id)).toMatchObject({ status: 'NO_SHOW', noShowAuto: true });
  });
});
