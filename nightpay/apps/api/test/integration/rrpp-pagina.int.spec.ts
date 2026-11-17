// Integración (Postgres real, np_app y FORCE RLS): «Tus reservas de RRPP» en
// la app del personal (GET /v1/staff/me/promoter). Cada RRPP ve solo lo suyo,
// en su local: su enlace, sus reservas (sin datos del cliente) y su comisión
// (ganada, por cobrar y cobrada), nunca lo de otro RRPP ni de otro local.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { ReservationsService, type BookingEntry } from '../../src/modules/reservations/reservations.service';
import { ReservationCatalogService } from '../../src/modules/reservations/reservation-catalog.service';
import { MyPromoterService } from '../../src/modules/reservations/my-promoter.service';
import { dateOfDay, nightOf } from '../../src/modules/reservations/reservation-rules';
import { madridAt, madridDay } from '../../src/common/time/madrid';

// A las 12:00 de Madrid de hoy: «esta noche» se puede reservar a cualquier hora que se lancen.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(madridAt(madridDay(new Date()), 12));

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
const reservations = new ReservationsService(prisma, payments, redis as never, audit);
const catalog = new ReservationCatalogService(prisma, audit, { get: () => 'https://api.prueba.es' } as never);
const mine = new MyPromoterService(prisma, catalog);

const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-rrpp' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));
type Actor = { userId: string; tenantId: string; role: string };
/** Como una petición del personal (su local y su persona en el contexto). */
const as = <T>(a: Actor, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-rrpp', tenantId: a.tenantId, userId: a.userId, role: a.role });
    return fn();
  });
const pageOf = (a: Actor) => as(a, () => mine.forUser(a));

const r = randomUUID().slice(0, 6);
const tonight = () => nightOf(new Date());
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
let orders = 0;

let A: string;
let B: string;
let me: Actor;
let otherRrpp: Actor;
let plainWaiter: Actor;
let meInB: Actor;
let myCode: string;
let otherCode: string;
let codeInB: string;
let pkg: string;
let pkgB: string;
const refs: Record<string, string> = {};
const owners: Record<string, { userId: string; role: 'OWNER'; tenantId: string }> = {};

async function entryOf(code: string): Promise<BookingEntry> {
  const entry = await pub(() => reservations.entryByPromoterCode(code));
  if (!entry) throw new Error('sin enlace de RRPP');
  return entry;
}

async function book(code: string, packageId: string, nightDate: string) {
  return pub(async () =>
    reservations.book(await entryOf(code), {
      packageId,
      nightDate,
      customerName: 'Laura Gómez',
      customerPhone: '600 11 22 33',
      notes: 'Cumpleaños de Laura',
      key: key(),
    }),
  );
}

/** El cliente paga en el banco y el banco lo aprueba (el aviso firmado). */
async function pay(manageToken: string, kind: 'DEPOSIT' | 'FULL') {
  const started = await pub(() => reservations.startPayment(manageToken, kind, 'es'));
  const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
  orders += 1;
  const order = `RP${r}${String(orders).padStart(4, '0')}`;
  await pub(() => payments.transition(p.id, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: p.id }, data: { provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId: p.id, tenantId: p.tenantId, provider: 'REDSYS', providerTxId: order, amountCents: p.amountCents + p.serviceFeeCents, tipCents: 0, claimHash: 'c'.repeat(64) },
    });
  });
  await pub(() => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
  return p;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala RRPP', slug: `rrpp-${r}`, walletGroup: `grrpp-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Otra Sala RRPP', slug: `rrppb-${r}`, walletGroup: `grrppb-${r}` } })).id;
    for (const t of [A, B]) {
      await tx.terminal.create({ data: { tenantId: t, externalId: `RP-BAR-${t.slice(0, 8)}`, label: 'Barra', zone: 'BARRA' } });
      await tx.gatewayCredential.create({
        data: { tenantId: t, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
      });
    }
    const user = (tenantId: string, role: string, tag: string) =>
      tx.user.create({ data: { tenantId, email: `${tag}-rrpp-${r}@x.es`, passwordHash: 'x', role } as never });
    me = { userId: (await user(A, 'WAITER', 'yo')).id, tenantId: A, role: 'WAITER' };
    otherRrpp = { userId: (await user(A, 'OPERATOR', 'otra')).id, tenantId: A, role: 'OPERATOR' };
    plainWaiter = { userId: (await user(A, 'WAITER', 'cam')).id, tenantId: A, role: 'WAITER' };
    myCode = `y${r}abcdefgh`.slice(0, 12);
    otherCode = `o${r}abcdefgh`.slice(0, 12);
    codeInB = `b${r}abcdefgh`.slice(0, 12);
    await tx.promoter.create({ data: { tenantId: A, userId: me.userId, commissionBps: 1000, code: myCode } });
    await tx.promoter.create({ data: { tenantId: A, userId: otherRrpp.userId, commissionBps: 2000, code: otherCode } });
    // La misma persona como RRPP de otro local (no debería pasar; si pasa, cada local va aparte).
    await tx.promoter.create({ data: { tenantId: B, userId: me.userId, commissionBps: 3000, code: codeInB } });
    meInB = { ...me, tenantId: B };
    for (const t of [A, B]) owners[t] = { userId: (await user(t, 'OWNER', t === A ? 'dueno' : 'duenob')).id, role: 'OWNER', tenantId: t };
  });
  const owner = (tenantId: string) => owners[tenantId]!;
  const mesa = { name: 'Mesa botellas', kind: 'ITEMS' as const, priceCents: 30000, creditCents: 0, entries: 6, items: [{ name: 'Botella', qty: 2 }] };
  pkg = (await pub(() => catalog.createPackage(owner(A), mesa))).id;
  pkgB = (await pub(() => catalog.createPackage(owner(B), { ...mesa, name: 'Mesa de B' }))).id;
  await pub(() => catalog.setEnabled(owner(A), true));
  await pub(() => catalog.setEnabled(owner(B), true));

  // Lo mío en A: pagada y ya cobrada, pagada por cobrar, con la señal, sin pagar y una noche pasada.
  const paidOut = await book(myCode, pkg, plusDays(tonight(), 5));
  const paid = await book(myCode, pkg, plusDays(tonight(), 6));
  const deposit = await book(myCode, pkg, plusDays(tonight(), 7));
  const unpaid = await book(myCode, pkg, plusDays(tonight(), 8));
  const past = await book(myCode, pkg, plusDays(tonight(), 9));
  await pay(paidOut.manageToken, 'FULL');
  await pay(paid.manageToken, 'FULL');
  await pay(deposit.manageToken, 'DEPOSIT');
  await pay(past.manageToken, 'DEPOSIT');
  await sys((tx) => tx.reservation.update({ where: { id: past.id }, data: { nightDate: dateOfDay(plusDays(tonight(), -3)), status: 'NO_SHOW', noShowAt: new Date() } }));
  // «Pagos a compañeras»: la comisión de la primera ya se le pagó.
  await sys(async (tx) => {
    const pays = await tx.reservationPayment.findMany({ where: { reservationId: paidOut.id, paymentId: { not: null } }, select: { paymentId: true } });
    const payout = await tx.operatorPayout.create({ data: { tenantId: A, operatorId: me.userId, totalCents: 3000, paidByUserId: me.userId } });
    await tx.operatorEarning.updateMany({ where: { operatorId: me.userId, paymentId: { in: pays.map((p) => p.paymentId!) } }, data: { payoutId: payout.id } });
  });

  // De otro RRPP del mismo local, pagada entera (su comisión es suya).
  const others = await book(otherCode, pkg, plusDays(tonight(), 5));
  const otherPayment = await pay(others.manageToken, 'FULL');
  // Una ganancia mía en un cobro de esa reserva ajena: no es comisión de mis reservas.
  await sys((tx) =>
    tx.operatorEarning.create({
      data: { tenantId: A, operatorId: me.userId, paymentId: otherPayment.id, paymentAmountCents: 30000, commissionBps: 500, commissionCents: 1500 },
    }),
  );
  // Lo mío en el otro local.
  const inB = await book(codeInB, pkgB, plusDays(tonight(), 5));
  await pay(inB.manageToken, 'FULL');

  Object.assign(refs, { paidOut: paidOut.ref, paid: paid.ref, deposit: deposit.ref, unpaid: unpaid.ref, past: past.ref, others: others.ref, inB: inB.ref });
});

afterAll(async () => {
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe('«Tus reservas de RRPP»', () => {
  it('su enlace, su % y sus reservas: las que vienen (por noche) y las pasadas', async () => {
    const page = await pageOf(me);
    expect(page).not.toBeNull();
    expect(page!.url).toBe(`https://api.prueba.es/reservar/${myCode}`);
    expect(page!.commissionBps).toBe(1000);
    expect(page!.upcoming.map((x) => x.ref)).toEqual([refs.paidOut, refs.paid, refs.deposit, refs.unpaid]);
    expect(page!.recent.map((x) => x.ref)).toEqual([refs.past]);
    expect(page!.upcoming.map((x) => [x.statusText, x.paidCents, x.pendingCents, x.commission])).toEqual([
      ['Pagado', 30000, 0, 'EARNED'],
      ['Pagado', 30000, 0, 'EARNED'],
      ['Señal pagada', 9000, 21000, 'EXPECTED'],
      ['Sin pagar', 0, 30000, 'EXPECTED'],
    ]);
    expect(page!.recent[0]).toMatchObject({ statusText: 'No vino', packageName: 'Mesa botellas', entries: 6, pendingCents: 0, commission: 'NONE' });
  });

  it('su comisión: ganada, por cobrar y cobrada (solo la de sus reservas)', async () => {
    const page = await pageOf(me);
    expect(page).toMatchObject({ earnedCents: 6000, toPayCents: 3000, paidCents: 3000 });
  });

  it('nada del cliente: ni nombre, ni teléfono, ni notas, ni el enlace de su reserva', async () => {
    const text = JSON.stringify(await pageOf(me));
    for (const secret of ['Laura', '600112233', '600 11 22 33', 'Cumpleaños']) expect(text).not.toContain(secret);
    const tokens = await sys((tx) => tx.reservation.findMany({ where: { promoter: { code: myCode } }, select: { manageToken: true, id: true } }));
    for (const t of tokens) {
      expect(text).not.toContain(t.manageToken);
      expect(text).not.toContain(t.id);
    }
  });

  it('nunca lo de otro RRPP ni lo de otro local', async () => {
    const text = JSON.stringify(await pageOf(me));
    expect(text).not.toContain(refs.others!);
    expect(text).not.toContain(refs.inB!);
    expect(text).not.toContain(otherCode);
    expect(text).not.toContain(codeInB);
    // El otro RRPP ve lo suyo, con su %, y nada mío.
    const other = await pageOf(otherRrpp);
    expect(other!.upcoming.map((x) => x.ref)).toEqual([refs.others]);
    expect(other).toMatchObject({ commissionBps: 2000, earnedCents: 6000, toPayCents: 6000, paidCents: 0 });
    // En el otro local, solo lo de ese local (el local sale de la sesión).
    const b = await pageOf(meInB);
    expect(b!.upcoming.map((x) => x.ref)).toEqual([refs.inB]);
    expect(b).toMatchObject({ url: `https://api.prueba.es/reservar/${codeInB}`, earnedCents: 9000, toPayCents: 9000 });
  });

  it('quien no es RRPP, o está de baja, no tiene página', async () => {
    expect(await pageOf(plainWaiter)).toBeNull();
    await sys((tx) => tx.promoter.update({ where: { code: otherCode }, data: { active: false } }));
    expect(await pageOf(otherRrpp)).toBeNull();
  });
});
