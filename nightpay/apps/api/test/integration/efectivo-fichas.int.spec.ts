// Integración (Postgres real, FORCE RLS, TENANCY_UNSCOPED_QUERIES=throw): revisión 3 del efectivo y las fichas.
//  - Tope legal del efectivo: el de un saldo y su cadena en 24 h no llega a 1.000 € (los troceados suman);
//    la anulación de una recarga mal tecleada (fila negativa) resta en el saldo, la caja y los totales.
//  - Devolver: en efectivo solo lo que entró en efectivo; con una devolución a la tarjeta a medias, nada.
//  - Fichas: la sustituida queda perdida (y vuelve si aparece), al sumar saldos la ficha va al bueno, una
//    ficha de otro grupo no se da y las noches cuentan eventos con el local de cada momento.
//  - Cierre: la caja sale de las mismas filas que el Z; cambiar el fondo apuntado y lo esperado negativo bloquean.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { fichasCounts } from '../../src/modules/wallets/fichas-counts';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async (_e: Record<string, unknown>) => undefined) };
const config = { get: () => undefined, getOrThrow: () => undefined };
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const reports = new ReportsService(prisma);
const incidents = new IncidentsService(prisma, audit as never);
const checks = new CloseCheckService(prisma, incidents, config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, totp as never);
vi.spyOn(nights as unknown as { safeAutoClose(tenantId: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
const period = new PeriodReportsService(prisma);
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never, totp as never);

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
const key = () => `rev3-${r}-${(k += 1)}`;

interface Local {
  id: string;
  owner: string;
  manager: string;
}

async function seedLocal(tag: string, group: string): Promise<Local> {
  return seed(async (tx) => {
    const id = (await tx.venue.create({ data: { name: `Local ${tag}`, slug: `r3-${tag}-${r}`, walletGroup: group } })).id;
    const user = (role: 'OWNER' | 'MANAGER') =>
      tx.user.create({ data: { tenantId: id, email: `${role.toLowerCase()}-${tag}-${r}@x.es`, passwordHash: 'x', role } as never });
    return { id, owner: (await user('OWNER')).id, manager: (await user('MANAGER')).id };
  });
}

let sala: Local;
let norte: Local;
let neon: Local;
let caja: Local;
let rojo: Local;

const managerOf = (l: Local) => ({ userId: l.manager, role: 'MANAGER' });
const managerActor = (l: Local) => ({ userId: l.manager, role: 'MANAGER' as const, tenantId: l.id });
const ownerActor = (l: Local) => ({ userId: l.owner, role: 'OWNER' as const, tenantId: l.id });
const newWallet = (l: Local, amountCents: number) =>
  inVenue(l.id, () => cash.topUp(l.id, managerOf(l), { amountCents, idempotencyKey: key(), wallet: { create: true } }));
const topUpCode = (l: Local, code: string, amountCents: number) =>
  inVenue(l.id, () => cash.topUp(l.id, managerOf(l), { amountCents, idempotencyKey: key(), wallet: { code } }));
const walletOf = async (id: string) => (await seed((tx) => tx.clientWallet.findUnique({ where: { id } })))!;
const cardOf = async (token: string) => (await seed((tx) => tx.walletCard.findUnique({ where: { token } })))!;
/**
 * El cierre cuenta hasta «ahora» (el reloj de Node) y las filas llevan la hora
 * de Postgres: con la máquina cargada, Node puede ir unas decenas de ms por
 * detrás. Antes de mirar la caja se espera a que lo alcance.
 */
async function afterDbClock(): Promise<void> {
  const rows = await seed((tx) => tx.$queryRaw<Array<{ t: Date }>>`SELECT clock_timestamp() AS t`);
  const ahead = (rows[0]?.t.getTime() ?? 0) - Date.now();
  if (ahead >= 0) await new Promise((resolve) => setTimeout(resolve, ahead + 20));
}
const stocked = async (l: Local) => {
  const { card } = await inVenue(l.id, () => cards.newStockToken(l.id, { userId: l.manager }));
  await inVenue(l.id, () => cards.stock(l.id, { userId: l.manager }, { card }));
  return card;
};

beforeAll(async () => {
  await prisma.onModuleInit();
  sala = await seedLocal('sala', `g3-${r}`);
  norte = await seedLocal('norte', `g3-${r}`);
  neon = await seedLocal('neon', `otro-${r}`);
  caja = await seedLocal('caja', `caja-${r}`);
  rojo = await seedLocal('rojo', `rojo-${r}`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la Idempotency-Key de la recarga en efectivo guarda lo pedido (Postgres real)', () => {
  const again = (input: Parameters<CashTopUpService['topUp']>[2]) =>
    inVenue(sala.id, () => cash.topUp(sala.id, managerOf(sala), input));
  const cashRows = (idempotencyKey: string) =>
    seed((tx) => tx.walletCashTopUp.count({ where: { tenantId: sala.id, idempotencyKey } }));

  it('otro destino, saldo nuevo u otro importe con la misma clave: 409 y no entra dinero', async () => {
    const mine = await newWallet(sala, 100);
    const other = await newWallet(sala, 100);
    const input = { amountCents: 100, idempotencyKey: key(), wallet: { code: mine.code } };
    await again(input);
    for (const changed of [{ ...input, wallet: { code: other.code } }, { ...input, wallet: { create: true as const } }, { ...input, amountCents: 101 }]) {
      await expect(again(changed)).rejects.toBeInstanceOf(ConflictException);
    }
    expect(await cashRows(input.idempotencyKey)).toBe(1);
    expect((await walletOf(mine.walletId)).balanceCents).toBe(200);
    expect((await walletOf(other.walletId)).balanceCents).toBe(100);
  });

  it('el mismo botón dos veces a la vez: una sola recarga y las dos respuestas son la misma', async () => {
    const mine = await newWallet(sala, 100);
    const input = { amountCents: 250, idempotencyKey: key(), wallet: { code: mine.code } };
    const [a, b] = await Promise.all([again(input), again(input)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect({ ...a, replayed: true }).toEqual({ ...b, replayed: true });
    expect(await cashRows(input.idempotencyKey)).toBe(1);
    expect((await walletOf(mine.walletId)).balanceCents).toBe(350);
  });

  it('el saldo se sumó a otro después: el reintento devuelve el recibo de entonces, no lo carga otra vez', async () => {
    const mine = await newWallet(sala, 100);
    const face = await newWallet(sala, 300);
    const input = { amountCents: 100, idempotencyKey: key(), wallet: { code: mine.code } };
    const first = await again(input);
    expect(first).toMatchObject({ balanceCents: 200, replayed: false });
    await inVenue(sala.id, () => charges.mergeInto(mine.walletId, face.walletId));
    await expect(again(input)).resolves.toEqual({ ...first, replayed: true });
    expect((await walletOf(face.walletId)).balanceCents).toBe(500);
    expect(await cashRows(input.idempotencyKey)).toBe(1);
  });

  it('filas de antes de la huella: vale el mismo saldo (o su cadena); otro saldo o uno nuevo, 409', async () => {
    const mine = await newWallet(sala, 100);
    const face = await newWallet(sala, 300);
    const other = await newWallet(sala, 100);
    const input = { amountCents: 100, idempotencyKey: key(), wallet: { code: mine.code } };
    const first = await again(input);
    await inVenue(sala.id, () => charges.mergeInto(mine.walletId, face.walletId));
    await seed((tx) => tx.walletCashTopUp.update({ where: { id: first.topUpId }, data: { intentFingerprint: null, receipt: Prisma.DbNull } }));
    for (const wallet of [{ code: mine.code }, { code: face.code }]) {
      await expect(again({ ...input, wallet })).resolves.toMatchObject({ topUpId: first.topUpId, replayed: true, createdWallet: false });
    }
    await expect(again({ ...input, wallet: { code: other.code } })).rejects.toBeInstanceOf(ConflictException);
    await expect(again({ ...input, wallet: { create: true } })).rejects.toBeInstanceOf(ConflictException);
    expect(await cashRows(input.idempotencyKey)).toBe(1);
  });
});

describe('tope legal del efectivo y anulación (Postgres real)', () => {
  it('999,99 € y luego 0,01 € al mismo saldo: no; la cadena de saldos sumados también cuenta', async () => {
    const a = await newWallet(sala, 99_999);
    await expect(topUpCode(sala, a.code, 1)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CASH_LIMIT' }) });
    expect((await walletOf(a.walletId)).balanceCents).toBe(99_999);

    // Recarga nueva de 500 € sumada (Face ID) al saldo de 400 €: juntos 900 € en efectivo hoy.
    const viejo = await newWallet(sala, 40_000);
    const nuevo = await newWallet(sala, 50_000);
    await inVenue(sala.id, () => charges.mergeInto(nuevo.walletId, viejo.walletId));
    await expect(topUpCode(sala, viejo.code, 20_000)).rejects.toThrow(/ya lleva 900,00\u00a0€.*como mucho 99,99\u00a0€ más/);
    await expect(topUpCode(sala, viejo.code, 9_999)).resolves.toMatchObject({ walletId: viejo.walletId, balanceCents: 99_999 });
    // El código de la recarga sumada ya no es de un saldo abierto (su dinero está en el bueno).
    await expect(topUpCode(sala, nuevo.code, 1)).rejects.toThrow();
  });

  it('anular una recarga mal tecleada: fila negativa, el saldo baja, la caja y los totales la restan', async () => {
    const before = await inVenue(caja.id, () => nights.open(caja.id, caja.manager, 0));
    const ok = await newWallet(caja, 5_000);
    // Se tecleó 949,99 en vez de 49,99.
    const mal = await topUpCode(caja, ok.code, 94_999);
    const out = await inVenue(caja.id, () => cash.voidTopUp(managerActor(caja), mal.topUpId, { reason: 'Era 49,99 €', totpCode: '123456' }));
    expect(out).toMatchObject({ walletId: ok.walletId, amountCents: 94_999, balanceCents: 5_000 });
    expect(await walletOf(ok.walletId)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    const rows = await seed((tx) => tx.walletCashTopUp.findMany({ where: { tenantId: caja.id }, orderBy: { createdAt: 'asc' } }));
    expect(rows.map((t) => [t.amountCents, t.voidOfId])).toEqual([
      [5_000, null],
      [94_999, null],
      [-94_999, mal.topUpId],
    ]);
    // Dos veces no: el índice único y la comprobación.
    await expect(inVenue(caja.id, () => cash.voidTopUp(managerActor(caja), mal.topUpId, { reason: 'otra', totpCode: '123456' }))).rejects.toThrow(
      /ya está anulada/,
    );
    // El tope de 24 h vuelve a tener sitio: la buena (44,99 €) entra.
    await expect(topUpCode(caja, ok.code, 4_499)).resolves.toMatchObject({ balanceCents: 9_499 });

    await afterDbClock();
    const check = await inVenue(caja.id, () => nights.closeCheck(caja.id));
    expect(check.cash).toMatchObject({ walletCashTopUpsCount: 2, walletCashTopUpsCents: 9_499, cashInCents: 9_499 });
    const totals = await period.totals(caja.id, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) });
    expect(totals).toMatchObject({ walletCashTopUpCount: 2, walletCashTopUpCents: 9_499 });
    const csvRows = await reports.recargasEfectivo(caja.id, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) });
    expect(csvRows.map((x) => x.amountCents)).toEqual([5_000, 94_999, -94_999, 4_499]);
    // Recientes para anular (las anuladas, marcadas).
    const recent = await inVenue(caja.id, () => cash.recent(caja.id));
    expect(recent.find((x) => x.id === mal.topUpId)).toMatchObject({ voided: true });
    expect(recent.find((x) => x.id === ok.topUpId)).toMatchObject({ voided: false, amountCents: 5_000 });

    const closed = await inVenue(caja.id, () =>
      nights.close(caja.id, { userId: caja.manager, role: 'MANAGER' }, before.id, {
        cashCountedCents: 9_499,
        acknowledged: ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'],
        note: 'prueba',
      }),
    );
    expect(closed.z.caja).toMatchObject({ walletCashTopUpsCount: 2, walletCashTopUpsCents: 9_499, expectedCents: 9_499, diffCents: 0 });
    expect(closed.z.summary).toMatchObject({ walletCashTopUpsCount: 2, walletCashTopUpsCents: 9_499 });
  });

  it('saldos nuevos en efectivo seguidos de la misma persona por más de 1.000 €: sale en Incidencias', async () => {
    audit.log.mockClear();
    await newWallet(rojo, 60_000);
    await newWallet(rojo, 60_000);
    const alert = audit.log.mock.calls.find((c) => c[0].action === 'wallet.cash_split_suspected');
    expect(alert?.[0]).toMatchObject({ tenantId: rojo.id, payload: expect.objectContaining({ count: 2, amountCents: 120_000 }) });
  });
});

describe('devolver: el efectivo, en efectivo (Postgres real)', () => {
  it('300 € en efectivo y 200 € de tarjeta: en efectivo salen 300 €; los 200 € siguen para «A la tarjeta»', async () => {
    const w = await newWallet(norte, 30_000);
    // La parte de la tarjeta (como si la hubiera sumado una recarga con tarjeta) y el «Me voy».
    await seed((tx) => tx.clientWallet.update({ where: { id: w.walletId }, data: { balanceCents: 50_000, closeRequestedAt: new Date() } }));
    await expect(inVenue(norte.id, () => charges.payout(managerActor(norte), w.walletId, { method: 'CASH', totpCode: '123456' }))).resolves.toEqual({
      refundedCents: 30_000,
      method: 'CASH',
      remainingCents: 20_000,
    });
    expect(await walletOf(w.walletId)).toMatchObject({ balanceCents: 20_000, status: 'ACTIVE' });
    // Ya no queda efectivo: lo que queda no sale en efectivo.
    await expect(inVenue(norte.id, () => charges.payout(ownerActor(norte), w.walletId, { totpCode: '123456', method: 'CASH' }))).rejects.toThrow(/entró con tarjeta/);
  });

  it('con una devolución a la tarjeta a medias no se paga en efectivo', async () => {
    const w = await newWallet(norte, 10_000);
    await seed((tx) =>
      tx.walletPayout.create({
        data: { tenantId: norte.id, walletId: w.walletId, amountCents: 5_000, method: 'CARD', status: 'PENDING', claimedAt: new Date(), paidByUserId: norte.owner },
      }),
    );
    await expect(inVenue(norte.id, () => charges.payout(ownerActor(norte), w.walletId, { totpCode: '123456', method: 'CASH' }))).rejects.toThrow(/a medias/);
    expect(await walletOf(w.walletId)).toMatchObject({ balanceCents: 10_000, status: 'ACTIVE' });
    // El panel lo ve antes de confirmar: nada en efectivo, «A la tarjeta» termina la de 50 €.
    await expect(inVenue(norte.id, () => charges.payoutPreview(ownerActor(norte), w.walletId))).resolves.toMatchObject({
      cashOutCents: 0,
      cardRefundCents: 5_000,
      pendingCardCents: 5_000,
    });
  });

  it('el panel ve antes de confirmar lo que se apunta; si el saldo se mueve entre medias, 409 y no sale nada', async () => {
    const w = await newWallet(norte, 30_000);
    await seed((tx) => tx.clientWallet.update({ where: { id: w.walletId }, data: { balanceCents: 50_000, closeRequestedAt: new Date() } }));
    const seen = await inVenue(norte.id, () => charges.payoutPreview(managerActor(norte), w.walletId));
    expect(seen).toEqual({ balanceCents: 50_000, cashOutCents: 30_000, cardRefundCents: 20_000, cashLaterCents: 0, bitcoinCents: 0, pendingCardCents: null });
    // Entre medias, otra persona le devuelve 100 € en efectivo (recepción).
    await seed(async (tx) => {
      await tx.walletPayout.create({
        data: { tenantId: norte.id, walletId: w.walletId, amountCents: 10_000, method: 'CASH', status: 'DONE', paidByUserId: norte.owner },
      });
      await tx.clientWallet.update({ where: { id: w.walletId }, data: { balanceCents: 40_000 } });
    });
    const stale = { method: 'CASH' as const, totpCode: '123456', expectedAmountCents: seen.cashOutCents };
    await expect(inVenue(norte.id, () => charges.payout(managerActor(norte), w.walletId, stale))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYOUT_AMOUNT_CHANGED' }),
    });
    expect(await walletOf(w.walletId)).toMatchObject({ balanceCents: 40_000, status: 'ACTIVE' });
    const now = await inVenue(norte.id, () => charges.payoutPreview(managerActor(norte), w.walletId));
    expect(now).toMatchObject({ cashOutCents: 20_000, cardRefundCents: 20_000 });
    await expect(
      inVenue(norte.id, () => charges.payout(managerActor(norte), w.walletId, { ...stale, expectedAmountCents: now.cashOutCents })),
    ).resolves.toEqual({ refundedCents: 20_000, method: 'CASH', remainingCents: 20_000 });
  });
});

describe('fichas: sustituir, sumar saldos, grupo y eventos por local (Postgres real)', () => {
  it('dar otra ficha al mismo saldo: la vieja queda perdida (fuera del stock) y vuelve si alguien la acerca', async () => {
    const [t1, t2] = [await stocked(sala), await stocked(sala)];
    const w = await newWallet(sala, 2_000);
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: w.code, card: t1 }));
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: w.code, card: t2 }));
    expect(await cardOf(t1)).toMatchObject({ status: 'LOST', walletId: null });
    expect(await cardOf(t2)).toMatchObject({ status: 'ISSUED', walletId: w.walletId });
    expect(await inVenue(sala.id, () => cards.stock(sala.id, { userId: sala.manager }, { card: t1 }))).toMatchObject({ outcome: 'returned' });
    expect(await cardOf(t1)).toMatchObject({ status: 'RETURNED' });
  });

  it('sumar la recarga al saldo del cliente: su ficha pasa al bueno y paga; la de antes del cliente queda sustituida', async () => {
    const [tCliente, tRecarga] = [await stocked(sala), await stocked(sala)];
    const cliente = await newWallet(sala, 3_000);
    const recarga = await newWallet(sala, 4_000);
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: cliente.code, card: tCliente }));
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: recarga.code, card: tRecarga }));
    await inVenue(sala.id, () => charges.mergeInto(recarga.walletId, cliente.walletId));
    expect(await cardOf(tRecarga)).toMatchObject({ status: 'ISSUED', walletId: cliente.walletId });
    expect(await cardOf(tCliente)).toMatchObject({ status: 'LOST', walletId: null });
    await expect(inVenue(sala.id, () => charges.lookupCard(sala.id, { card: tRecarga }))).resolves.toMatchObject({
      walletId: cliente.walletId,
      balanceCents: 7_000,
    });
    // «Preparar fichas» no la ve libre: es de un cliente con saldo.
    expect(await inVenue(sala.id, () => cards.stock(sala.id, { userId: sala.manager }, { card: tRecarga }))).toMatchObject({ outcome: 'in-use' });
  });

  it('una ficha del stock de otro grupo de locales no se da', async () => {
    const ajena = await stocked(neon);
    const w = await newWallet(sala, 1_000);
    await expect(inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: w.code, card: ajena }))).rejects.toThrow(/no es nuestra/);
    expect(await cardOf(ajena)).toMatchObject({ status: 'STOCK', venueId: neon.id, walletId: null });
  });

  it('las noches cuentan eventos con el local de cada momento: dada en Sala, devuelta en Norte; dada dos veces = dos', async () => {
    const from = new Date();
    const t = await stocked(sala);
    const a = await newWallet(sala, 1_000);
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: a.code, card: t }));
    // «Me voy» en Norte (mismo grupo): la ficha vuelve al stock de Norte.
    await seed((tx) => tx.clientWallet.update({ where: { id: a.walletId }, data: { closeRequestedAt: new Date() } }));
    await inVenue(norte.id, () => charges.payout(managerActor(norte), a.walletId, { method: 'CASH' }));
    expect(await cardOf(t)).toMatchObject({ status: 'RETURNED', venueId: norte.id });
    // Y Sala la vuelve a dar a otro cliente esa misma noche.
    const b = await newWallet(sala, 1_000);
    await inVenue(sala.id, () => charges.linkCard(managerActor(sala), { code: b.code, card: t }));
    const window = { from, to: new Date(Date.now() + 1_000) };
    const enSala = await seed((tx) => fichasCounts(tx, sala.id, window));
    const enNorte = await seed((tx) => fichasCounts(tx, norte.id, window));
    expect(enSala).toMatchObject({ entregadas: 2, devueltas: 0 });
    expect(enNorte).toMatchObject({ entregadas: 0, devueltas: 1 });
  });

  it('la base: ACTIVE aún vale (paso 1 de 2, el API anterior) y el API la lee como dada', async () => {
    const w = await newWallet(sala, 1_500);
    const token = `fichaDelApiAnterior${r}`;
    await seed((tx) => tx.walletCard.create({ data: { token, status: 'ACTIVE', walletId: w.walletId, venueId: sala.id } }));
    await expect(inVenue(sala.id, () => charges.lookupCard(sala.id, { card: token }))).resolves.toMatchObject({ walletId: w.walletId, hasCard: true });
    await expect(seed((tx) => tx.walletCard.create({ data: { token: `fichaRara${r}xxxxxxx`, status: 'RARO' } }))).rejects.toThrow();
  });
});

describe('cierre de la noche: la caja y los fondos (Postgres real)', () => {
  it('el fondo apuntado al abrir: el encargado no lo cambia; el dueño con su 2FA sí y el Z guarda los dos', async () => {
    const night = await inVenue(norte.id, () => nights.open(norte.id, norte.manager, 10_000));
    await newWallet(norte, 5_000);
    const all = ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'] as const;
    const typed = { openingFloatCents: 5_000, cashCountedCents: 10_000, acknowledged: [...all], note: 'prueba' };
    await afterDbClock();
    await expect(inVenue(norte.id, () => nights.close(norte.id, { userId: norte.manager, role: 'MANAGER' }, night.id, typed))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NIGHT_CLOSE_BLOCKED', missing: ['efectivo'] }),
    });
    const closed = await inVenue(norte.id, () =>
      nights.close(norte.id, { userId: norte.owner, role: 'OWNER' }, night.id, { ...typed, totpCode: '123456' }),
    );
    expect(closed.z.caja).toMatchObject({ openingFloatCents: 5_000, recordedFloatCents: 10_000, expectedCents: 10_000, diffCents: 0 });
    // La caja y el resumen del mismo Z salen de las mismas filas.
    expect(closed.z.caja?.walletCashTopUpsCents).toBe(closed.z.summary.walletCashTopUpsCents);
    expect(closed.z.caja?.walletCashPayoutsCents).toBe(closed.z.summary.walletCashPayoutsCents);
  });

  it('lo esperado negativo (salió más efectivo del que entró más el fondo) bloquea el cierre', async () => {
    const night = await inVenue(rojo.id, () => nights.open(rojo.id, rojo.manager, 0));
    const chica = await seed((tx) =>
      tx.user.create({ data: { tenantId: rojo.id, email: `chica-rojo-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } as never }),
    );
    await seed((tx) =>
      tx.operatorPayout.create({
        data: { tenantId: rojo.id, operatorId: chica.id, totalCents: 200_000, externalRail: 'MANUAL_CASH', paidByUserId: rojo.manager } as never,
      }),
    );
    await afterDbClock();
    const err = await inVenue(rojo.id, () =>
      nights.close(rojo.id, { userId: rojo.manager, role: 'MANAGER' }, night.id, {
        cashCountedCents: 0,
        acknowledged: ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'],
        note: 'prueba',
      }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ response: expect.objectContaining({ code: 'NIGHT_CLOSE_BLOCKED' }) });
    expect((err as Error).message).toMatch(/negativo/);
  });
});
