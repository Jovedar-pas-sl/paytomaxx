// Integración (Postgres real, np_app y FORCE RLS): reservados con señal y RRPP.
// Paquetes de cosas fijas y de importe; reservar (la misma clave = la misma
// reserva, tope por noche); pagar la señal, el resto o todo con tarjeta (un
// cobro de recarga del saldo del grupo: SOLO cuenta con la aprobación del
// banco, sin saldo a la vista de quien paga); cambiar la fecha una vez con 48 h;
// la llegada (pasa a venta) y la barra con el QR de cada persona; «No vino»
// (la señal no se devuelve, el 70 % queda de saldo); el local anula; la
// comisión del RRPP solo con el paquete pagado entero; «Señales de reservas».
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { ReservationsService, type BookingEntry } from '../../src/modules/reservations/reservations.service';
import { ReservationOpsService } from '../../src/modules/reservations/reservation-ops.service';
import { ReservationCatalogService } from '../../src/modules/reservations/reservation-catalog.service';
import { nightOf, nightEnd } from '../../src/modules/reservations/reservation-rules';
import { madridAt, madridDay } from '../../src/common/time/madrid';
import { PromotersService } from '../../src/modules/reservations/promoters.service';
import { lockPayableEarnings } from '../../src/modules/operators/payout-selection';

// La hora, fija a las 12:00 de Madrid de hoy: «esta noche» se puede reservar
// (hasta 2 h antes de abrir) a cualquier hora que se lancen las pruebas.
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
const reservations = new ReservationsService(prisma, payments, redis as never, audit);
const ops = new ReservationOpsService(prisma, audit, reservations, payments, new CashTopUpService(prisma, audit, {} as never));
const catalog = new ReservationCatalogService(prisma, audit, { get: () => 'https://api.prueba.es' } as never);
const promoters = new PromotersService(prisma, audit, catalog);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never, {} as never);

const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-resv' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));
/** Como una petición del personal (su local y su persona en el contexto). */
const as = <T>(a: { userId: string; tenantId: string; role: string }, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-resv', tenantId: a.tenantId, userId: a.userId, role: a.role });
    return fn();
  });

const r = randomUUID().slice(0, 6);
let A: string;
let B: string;
let owner: { userId: string; role: 'OWNER'; tenantId: string };
let door: { userId: string; role: 'WAITER'; tenantId: string };
let barman: { userId: string; role: 'WAITER'; tenantId: string };
let rrppUser: string;
let promoterId: string;
let itemsPkg: string;
let creditPkg: string;
const tonight = () => nightOf(new Date());
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
let orders = 0;

async function entryWeb(): Promise<BookingEntry> {
  const settings = await pub(() => catalog.settings(A));
  const code = (settings.url ?? '').split('/reservar/')[1] ?? '';
  const entry = await pub(() => reservations.entryByVenueCode(code));
  if (!entry) throw new Error('sin entrada web');
  return entry;
}

async function book(entry: BookingEntry, packageId: string, nightDate: string, k = key()) {
  return pub(() => reservations.book(entry, { packageId, nightDate, customerName: 'Laura Gómez', customerPhone: '600 11 22 33', key: k }));
}

/** El cliente paga en el banco y el banco lo aprueba (el aviso firmado). */
async function payAtBank(paymentId: string, tenantId: string, chargedCents: number): Promise<string> {
  orders += 1;
  const order = `RV${r}${String(orders).padStart(4, '0')}`;
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId, tenantId, provider: 'REDSYS', providerTxId: order, amountCents: chargedCents, tipCents: 0, claimHash: 'c'.repeat(64) },
    });
  });
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
  return order;
}

async function pay(manageToken: string, kind: 'DEPOSIT' | 'REST' | 'FULL') {
  const started = await pub(() => reservations.startPayment(manageToken, kind, 'es'));
  const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
  const order = await payAtBank(p.id, p.tenantId, p.amountCents + p.serviceFeeCents);
  return { payment: p, order };
}

const resvOf = (id: string) => sys((tx) => tx.reservation.findUniqueOrThrow({ where: { id } }));
const walletOf = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));
const code = (err: unknown) => ((err as HttpException).getResponse() as { code?: string }).code;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Reservas', slug: `resv-${r}`, walletGroup: `gresv-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: A, externalId: `RV-BAR-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    B = (await tx.venue.create({ data: { name: 'Otra Sala', slug: `resvb-${r}` } })).id;
    const user = (role: string, tag: string, post?: string) =>
      tx.user.create({ data: { tenantId: A, email: `${tag}-resv-${r}@x.es`, passwordHash: 'x', role, ...(post ? { post } : {}) } as never });
    owner = { userId: (await user('OWNER', 'own')).id, role: 'OWNER', tenantId: A };
    door = { userId: (await user('WAITER', 'rec', 'RECEPCION')).id, role: 'WAITER', tenantId: A };
    barman = { userId: (await user('WAITER', 'bar', 'BARRA')).id, role: 'WAITER', tenantId: A };
    rrppUser = (await user('WAITER', 'rrpp')).id;
    promoterId = (await tx.promoter.create({ data: { tenantId: A, userId: rrppUser, commissionBps: 1000, code: `rp${r}abcdef`.slice(0, 12) } })).id;
  });
  itemsPkg = (
    await pub(() =>
      catalog.createPackage(owner, {
        name: 'Mesa botellas',
        kind: 'ITEMS',
        priceCents: 30000,
        creditCents: 0,
        entries: 6,
        items: [
          { name: 'Botella', qty: 2 },
          { name: 'Entrada', qty: 6 },
        ],
        maxPerNight: 3,
      }),
    )
  ).id;
  creditPkg = (
    await pub(() => catalog.createPackage(owner, { name: 'Mesa consumo', kind: 'CREDIT', priceCents: 50000, creditCents: 40000, entries: 4, items: [] }))
  ).id;
  await pub(() => catalog.setEnabled(owner, true));
});

afterEach(() => {
  vi.setSystemTime(BASE_NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe('paquetes y reservar', () => {
  it('el paquete guarda su señal (30 %); la base no deja uno de cosas fijas con importe', async () => {
    const list = await pub(() => catalog.packages(owner));
    expect(list.find((p) => p.id === itemsPkg)).toMatchObject({ priceCents: 30000, depositCents: 9000, entries: 6, kind: 'ITEMS' });
    await expect(
      sys((tx) => tx.reservationPackage.create({ data: { tenantId: A, name: 'Malo', kind: 'ITEMS', priceCents: 1000, creditCents: 500, entries: 1 } })),
    ).rejects.toThrow();
  });

  it('reservar: sin pagar, un QR por persona y «vendido por» la web; la misma clave = la misma reserva', async () => {
    const entry = await entryWeb();
    const k = key();
    const one = await book(entry, itemsPkg, plusDays(tonight(), 10), k);
    const again = await book(entry, itemsPkg, plusDays(tonight(), 10), k);
    expect(again.id).toBe(one.id);
    const row = await resvOf(one.id);
    expect(row).toMatchObject({ status: 'PENDING', paidCents: 0, priceCents: 30000, depositCents: 9000, source: 'WEB', promoterId: null, customerPhone: '600112233' });
    expect(await sys((tx) => tx.reservationGuest.count({ where: { reservationId: one.id } }))).toBe(6);
  });

  it('tope por noche del paquete: la cuarta de la misma noche no entra', async () => {
    // Las sin pagar cuentan 30 min desde su createdAt, que pone la base con su
    // hora real: con el reloj de las 12:00, de 00:00 a 11:30 no contaban y la
    // cuarta entraba. Con la hora real vale a cualquier hora (la noche es dentro
    // de 20 días; afterEach vuelve a las 12:00).
    vi.setSystemTime(vi.getRealSystemTime());
    const entry = await entryWeb();
    const night = plusDays(tonight(), 20);
    for (let i = 0; i < 3; i += 1) await book(entry, itemsPkg, night);
    const err = await book(entry, itemsPkg, night).catch((e: unknown) => e);
    expect(code(err)).toBe('RESERVATION_FULL');
  });
});

describe('pagar: solo con la aprobación del banco', () => {
  it('la señal: cobro de recarga de un saldo nuevo del grupo; en el banco aún no cuenta; aprobado → Señal pagada', async () => {
    const entry = await entryWeb();
    const res = await book(entry, itemsPkg, plusDays(tonight(), 5));
    const started = await pub(() => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'));
    // Doble toque: el mismo cobro.
    const again = await pub(() => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'));
    expect(again.payToken).toBe(started.payToken);
    const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
    expect(p).toMatchObject({ amountCents: 9000, captureMethod: 'WALLET_TOPUP', idempotencyKey: `resv:${res.id}:DEPOSIT:1` });
    expect(p.walletId).not.toBeNull();
    // En el banco (AUTHORIZING): nada pagado todavía.
    await pub(() => payments.transition(p.id, { type: 'AUTHORIZING' }));
    expect(await resvOf(res.id)).toMatchObject({ status: 'PENDING', paidCents: 0, walletId: null });
    // El aviso del banco.
    orders += 1;
    const order = `RV${r}${String(orders).padStart(4, '0')}`;
    await sys(async (tx) => {
      await tx.payment.update({ where: { id: p.id }, data: { provider: 'REDSYS', providerTxId: order } });
      await tx.paymentAttempt.create({ data: { paymentId: p.id, tenantId: A, provider: 'REDSYS', providerTxId: order, amountCents: 9000, tipCents: 0, claimHash: 'c'.repeat(64) } });
    });
    await pub(() => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
    const row = await resvOf(res.id);
    expect(row).toMatchObject({ status: 'DEPOSIT_PAID', paidCents: 9000, walletId: p.walletId });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(9000);
    // Quien paga no se lleva el saldo del grupo (la señal es saldo al llegar) ni bitcoin.
    const view = await pub(() => payments.getResultView(order));
    expect(view?.walletToken ?? null).toBeNull();
    expect(view && 'walletFromHome' in view).toBe(false);
    // Al pagarse, el navegador que pagó vuelve a la página del reservado.
    expect(view?.reservation).toBe(true);
    expect(await pub(() => payments.reservationManageToken(p.id))).toBe(res.manageToken);
    // Contabilidad aparte: en reservation_payments, con su hora de pago.
    expect(await sys((tx) => tx.reservationPayment.findUniqueOrThrow({ where: { paymentId: p.id } }))).toMatchObject({ kind: 'DEPOSIT', amountCents: 9000 });
    // Señal pagada: ya no se puede pagar otra señal; sí el resto.
    expect(code(await pub(() => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es')).catch((e: unknown) => e))).toBe('RESERVATION_NOT_PAYABLE');
    await pay(res.manageToken, 'REST');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', paidCents: 30000 });
    expect((await walletOf(p.walletId!)).balanceCents).toBe(30000);
  });

  it('aprobado pero sin sumar al saldo (cerrado al caducar): la reserva no se da por pagada y queda la incidencia', async () => {
    const entry = await entryWeb();
    const res = await book(entry, creditPkg, plusDays(tonight(), 4));
    const started = await pub(() => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'));
    const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
    // Como el barrido de una recarga sin pagar: su saldo vacío se cierra.
    await sys((tx) => tx.clientWallet.update({ where: { id: p.walletId! }, data: { status: 'EXPIRED' } }));
    await payAtBank(p.id, A, p.amountCents);
    expect(await resvOf(res.id)).toMatchObject({ status: 'PENDING', paidCents: 0, walletId: null });
    const incident = await sys((tx) => tx.auditEvent.findFirst({ where: { targetId: res.id, action: 'reservation.payment_unapplied' } }));
    expect(incident?.payload).toMatchObject({ reason: 'not_credited', paymentId: p.id });
  });

  it('cambiar de «señal» a «todo» con un pago a medias: el de antes se cancela', async () => {
    const entry = await entryWeb();
    const res = await book(entry, creditPkg, plusDays(tonight(), 6));
    const dep = await pub(() => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'));
    const full = await pub(() => reservations.startPayment(res.manageToken, 'FULL', 'es'));
    expect(full.payToken).not.toBe(dep.payToken);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: dep.payToken } }))).status).toBe('CANCELED');
  });
});

describe('cambiar la fecha (el cliente)', () => {
  it('una sola vez, con la señal pagada y 48 h antes', async () => {
    const entry = await entryWeb();
    const res = await book(entry, creditPkg, plusDays(tonight(), 7));
    expect(code(await pub(() => reservations.changeDate(res.manageToken, plusDays(tonight(), 9))).catch((e: unknown) => e))).toBe('RESERVATION_CHANGE');
    await pay(res.manageToken, 'DEPOSIT');
    await pub(() => reservations.changeDate(res.manageToken, plusDays(tonight(), 9)));
    const row = await resvOf(res.id);
    expect(row.nightDate.toISOString().slice(0, 10)).toBe(plusDays(tonight(), 9));
    expect(row.previousNightDate?.toISOString().slice(0, 10)).toBe(plusDays(tonight(), 7));
    const second = await pub(() => reservations.changeDate(res.manageToken, plusDays(tonight(), 11))).catch((e: unknown) => e);
    expect(((second as HttpException).getResponse() as { message: string }).message).toBe('La fecha solo se puede cambiar una vez');
    // Menos de 48 h: no.
    const soon = await book(entry, creditPkg, tonight());
    await pay(soon.manageToken, 'DEPOSIT');
    const late = await pub(() => reservations.changeDate(soon.manageToken, plusDays(tonight(), 4))).catch((e: unknown) => e);
    expect(((late as HttpException).getResponse() as { message: string }).message).toBe('La fecha se cambia avisando con 48 horas');
  });
});

describe('la noche: puerta, barra, «No vino» y el local anula', () => {
  it('cosas fijas: el resto en la puerta, la llegada pasa el paquete a venta y la barra sirve con el QR de cada persona', async () => {
    const entry = await entryWeb();
    const res = await book(entry, itemsPkg, tonight());
    await pay(res.manageToken, 'DEPOSIT');
    // En la puerta: falta el resto → no se da la llegada; «Cobrar el resto» y el cliente lo paga.
    expect(code(await as(door, () => ops.arrive(door, res.id)).catch((e: unknown) => e))).toBe('RESERVATION_ARRIVAL');
    const rest = await as(door, () => ops.collectRest(door, res.id));
    const restPayment = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: rest.payToken } }));
    expect(restPayment).toMatchObject({ amountCents: 21000, createdByUserId: door.userId });
    await payAtBank(restPayment.id, A, 21000);
    const guests = await sys((tx) => tx.reservationGuest.findMany({ where: { reservationId: res.id }, orderBy: { seq: 'asc' } }));
    const scanned = await as(door, () => ops.byGuest(door, `https://api.prueba.es/reservas/q/${guests[1]!.qrToken}`));
    expect(scanned.guest.seq).toBe(2);
    const arrived = await as(door, () => ops.arrive(door, res.id, scanned.guest.id));
    expect(arrived).toMatchObject({ status: 'ARRIVED', balanceCents: 0 });
    const row = await resvOf(res.id);
    const sale = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: row.walletId!, idempotencyKey: `resv-arrive:${res.id}` } }));
    expect(sale).toMatchObject({ amountCents: 30000, category: 'VENUE_ENTRY', authMethod: 'staff' });
    // La mesa la pone el local.
    expect((await as(door, () => ops.setTable(door, res.id, 'VIP 3'))).tableLabel).toBe('VIP 3');
    // Barra: dos botellas con el QR de la persona 3; la tercera no.
    const k1 = key();
    await as(barman, () => ops.serve(barman, { guestToken: guests[2]!.qrToken, itemName: 'Botella', qty: 1, key: k1 }));
    await as(barman, () => ops.serve(barman, { guestToken: guests[2]!.qrToken, itemName: 'Botella', qty: 1, key: k1 })); // repetido: nada
    const after = await as(barman, () => ops.serve(barman, { guestToken: guests[3]!.qrToken, itemName: 'Botella', qty: 1, key: key() }));
    expect(after.itemsLeft.find((i) => i.name === 'Botella')?.left).toBe(0);
    expect(after.guests.find((g) => g.seq === 3)?.items).toEqual([{ name: 'Botella', qty: 1 }]);
    const third = await as(barman, () => ops.serve(barman, { guestToken: guests[0]!.qrToken, itemName: 'Botella', qty: 1, key: key() })).catch((e: unknown) => e);
    expect(code(third)).toBe('RESERVATION_ITEM_LEFT');
    // Un paquete de cosas no se cobra en importe.
    expect(code(await as(barman, () => ops.charge(barman, { guestToken: guests[0]!.qrToken, amountCents: 500, key: key() })).catch((e: unknown) => e))).toBe('RESERVATION_KIND');
  });

  it('importe: al llegar pasa a venta lo que no es para consumir; cada persona gasta del saldo del grupo; lo que sobra no se devuelve en dinero', async () => {
    const entry = await entryWeb();
    const res = await book(entry, creditPkg, tonight());
    const { payment } = await pay(res.manageToken, 'FULL');
    const guests = await sys((tx) => tx.reservationGuest.findMany({ where: { reservationId: res.id }, orderBy: { seq: 'asc' } }));
    // Antes de llegar, la barra no cobra.
    expect(code(await as(barman, () => ops.charge(barman, { guestToken: guests[0]!.qrToken, amountCents: 1000, key: key() })).catch((e: unknown) => e))).toBe('RESERVATION_NOT_ARRIVED');
    await as(door, () => ops.arrive(door, res.id));
    expect((await walletOf(payment.walletId!)).balanceCents).toBe(40000);
    const k = key();
    await as(barman, () => ops.charge(barman, { guestToken: guests[1]!.qrToken, amountCents: 5000, key: k }));
    const view = await as(barman, () => ops.charge(barman, { guestToken: guests[1]!.qrToken, amountCents: 5000, key: k })); // repetido
    expect(view.balanceCents).toBe(35000);
    expect(view.guests.find((g) => g.seq === 2)?.spentCents).toBe(5000);
    const tooMuch = await as(barman, () => ops.charge(barman, { guestToken: guests[2]!.qrToken, amountCents: 40000, key: key() })).catch((e: unknown) => e);
    expect(code(tooMuch)).toBe('RESERVATION_BALANCE');
    // «Me voy» (devolver el saldo): el saldo no se devuelve, tampoco el de un reservado.
    const w = await walletOf(payment.walletId!);
    expect(code(await pub(() => charges.requestClose(w.qrToken)).catch((e: unknown) => e))).toBe('SALDO_NO_SE_DEVUELVE');
  });

  it('«No vino» con el 100 % pagado: pierde la señal y el 70 % queda como saldo; con la señal sola, la pierde', async () => {
    const entry = await entryWeb();
    const night = tonight();
    const full = await book(entry, itemsPkg, night);
    const { payment } = await pay(full.manageToken, 'FULL');
    const dep = await book(entry, creditPkg, night);
    const depPaid = await pay(dep.manageToken, 'DEPOSIT');
    // Durante la noche, no (la reserva se guarda toda la noche).
    expect(code(await as(owner, () => ops.noShow(owner, full.id)).catch((e: unknown) => e))).toBe('RESERVATION_NO_SHOW');
    // El camarero no puede.
    await expect(as(door, () => ops.noShow(door, full.id))).rejects.toThrow('Solo el encargado o el dueño');
    vi.setSystemTime(new Date(nightEnd(night).getTime() + 60_000));
    expect((await as(owner, () => ops.noShow(owner, full.id))).status).toBe('NO_SHOW');
    expect((await walletOf(payment.walletId!)).balanceCents).toBe(21000);
    await as(owner, () => ops.noShow(owner, dep.id));
    expect((await walletOf(depPaid.payment.walletId!)).balanceCents).toBe(0);
    const lost = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { idempotencyKey: { startsWith: `resv-noshow:${full.id}:` } } }));
    expect(lost).toMatchObject({ amountCents: 9000, category: 'VENUE_ENTRY' });
    // La página del grupo le da el enlace a su saldo para otra noche.
    expect((await pub(() => reservations.groupView(full.manageToken)))?.saldoHref).toMatch(/^\/w\//);
  });

  it('el local anula: sin pagar se cancela; pagada, el saldo del grupo se puede devolver', async () => {
    const entry = await entryWeb();
    const unpaid = await book(entry, creditPkg, plusDays(tonight(), 3));
    expect((await as(owner, () => ops.venueCancel(owner, unpaid.id, 'Cerramos esa noche'))).refundCents).toBe(0);
    const paid = await book(entry, creditPkg, plusDays(tonight(), 3));
    const { payment } = await pay(paid.manageToken, 'DEPOSIT');
    // Primero se ofrece otra fecha (no gasta el cambio del cliente).
    await as(owner, () => ops.venueChangeDate(owner, paid.id, plusDays(tonight(), 8)));
    expect((await resvOf(paid.id)).dateChangedAt).toBeNull();
    const out = await as(owner, () => ops.venueCancel(owner, paid.id, 'No le vale otra fecha'));
    expect(out).toMatchObject({ refundCents: 15000, walletId: payment.walletId });
    const w = await walletOf(payment.walletId!);
    expect(code(await pub(() => charges.requestClose(w.qrToken)).catch((e: unknown) => e))).toBe('SALDO_NO_SE_DEVUELVE');
    expect((await walletOf(payment.walletId!)).closeRequestedAt).toBeNull();
  });
});

describe('RRPP: «vendido por» y la comisión con el paquete pagado entero', () => {
  it('su enlace guarda el RRPP y su %; la comisión llega solo al pagarse el resto, una vez, al reparto de siempre', async () => {
    const promoter = await sys((tx) => tx.promoter.findUniqueOrThrow({ where: { id: promoterId } }));
    const entry = await pub(() => reservations.entryByPromoterCode(promoter.code));
    expect(entry).toMatchObject({ venueId: A, source: 'RRPP', promoter: { id: promoterId, bps: 1000 } });
    const res = await book(entry!, creditPkg, plusDays(tonight(), 12));
    // El % cambia después: la reserva guarda el de la venta.
    await sys((tx) => tx.promoter.update({ where: { id: promoterId }, data: { commissionBps: 2000 } }));
    const dep = await pay(res.manageToken, 'DEPOSIT');
    expect(await sys((tx) => tx.operatorEarning.count({ where: { operatorId: rrppUser } }))).toBe(0);
    const rest = await pay(res.manageToken, 'REST');
    const earnings = await sys((tx) => tx.operatorEarning.findMany({ where: { operatorId: rrppUser } }));
    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject({ paymentId: rest.payment.id, paymentAmountCents: 50000, commissionBps: 1000, commissionCents: 5000, payoutId: null });
    expect(dep.payment.id).not.toBe(rest.payment.id);
    expect((await resvOf(res.id)).commissionEarnedAt).not.toBeNull();
    const list = await pub(() => ops.detail(owner, res.id));
    expect(list.soldBy).toBe('RRPP: rrpp-resv-' + r + '@x.es');
  });
});

describe('RRPP: alta, su enlace y el reparto', () => {
  it('alta solo del dueño y de alguien que cobra en el reparto; una vez por persona', async () => {
    const chica = await sys((tx) => tx.user.create({ data: { tenantId: A, email: `chica-resv-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Marina' } }));
    const manager = await sys((tx) => tx.user.create({ data: { tenantId: A, email: `enc-resv-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } }));
    await expect(as(door, () => promoters.create(door, { userId: chica.id, commissionBps: 1500 }))).rejects.toThrow('El % de los RRPP lo pone el dueño');
    await expect(as(owner, () => promoters.create(owner, { userId: manager.id, commissionBps: 1500 }))).rejects.toThrow('compañera o un camarero');
    const created = await as(owner, () => promoters.create(owner, { userId: chica.id, commissionBps: 1500 }));
    expect(created).toMatchObject({ name: 'Marina', commissionBps: 1500, active: true, soldCount: 0 });
    expect(created.url).toMatch(/^https:\/\/api\.prueba\.es\/reservar\/[A-Za-z0-9_-]{12}$/);
    await expect(as(owner, () => promoters.create(owner, { userId: chica.id, commissionBps: 1000 }))).rejects.toThrow('Esa persona ya es RRPP');
    // De baja: su enlace deja de valer.
    const code = created.url.split('/reservar/')[1]!;
    expect(await pub(() => reservations.entryByPromoterCode(code))).not.toBeNull();
    await as(owner, () => promoters.update(owner, created.id, { active: false }));
    expect(await pub(() => reservations.entryByPromoterCode(code))).toBeNull();
  });

  it('lo vendido y su comisión salen en su ficha y entran en el reparto de siempre', async () => {
    const list = await as(owner, () => promoters.list(owner));
    expect(list.find((p) => p.id === promoterId)).toMatchObject({ soldCount: 1, commissionCents: 5000 });
    const payable = await sys((tx) => lockPayableEarnings(tx, A, rrppUser, new Date(Math.max(REAL_NOW, Date.now()) + 86_400_000)));
    expect(payable).toEqual([expect.objectContaining({ commissionCents: 5000, tipCents: 0, reversedCents: 0 })]);
  });
});

describe('«Señales de reservas» y aislamiento', () => {
  it('lo cobrado, lo pasado a venta, a saldo, lo pendiente y la comisión, aparte de las ventas', async () => {
    const acc = await pub(() => catalog.accounting(owner, plusDays(tonight(), -1), plusDays(tonight(), 1)));
    expect(acc.collectedCents).toBeGreaterThan(0);
    // Llegadas (30.000 + 10.000) y señales perdidas (9.000 + 15.000).
    expect(acc.recognizedCents).toBe(30000 + 10000 + 9000 + 15000);
    expect(acc.toSaldoCents).toBe(40000 + 21000);
    expect(acc.promoterCommissionCents).toBe(5000);
    const pending = await sys((tx) => tx.reservation.aggregate({ where: { tenantId: A, status: { in: ['DEPOSIT_PAID', 'PAID'] } }, _sum: { paidCents: true } }));
    expect(acc.outstandingCents).toBe(pending._sum.paidCents ?? 0);
  });

  it('otro local no ve ni toca las reservas de este', async () => {
    const other = { userId: randomUUID(), role: 'OWNER', tenantId: B };
    expect(await as(other, () => ops.night(other, tonight()))).toEqual([]);
    const any = await sys((tx) => tx.reservation.findFirstOrThrow({ where: { tenantId: A } }));
    await expect(as(other, () => ops.detail(other, any.id))).rejects.toThrow('Reserva no encontrada');
    const g = await sys((tx) => tx.reservationGuest.findFirstOrThrow({ where: { tenantId: A } }));
    await expect(as(other, () => ops.byGuest(other, g.qrToken))).rejects.toThrow('Ese QR no es de un reservado de este local');
  });
});
