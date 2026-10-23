// Integración (Postgres real, np_app con FORCE RLS): los escenarios de la «Copa
// con invitación» que faltaban, cada uno en su local: dos chicas (dos
// invitaciones de la misma noche y un cobro con una línea para cada una),
// invitación con propina, devolución en parte otra noche (y después de pagar a
// la chica) y la invitación del saldo con el NFC del cliente. En todos, el mapa
// del dinero, la ficha de cada chica y el Z cuadran. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CreatePaymentSchema, type MoneyMap } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { cobrosCsv } from '../../src/modules/reports/export-csv';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const config = { get: () => undefined, getOrThrow: () => undefined };
const metrics = {
  paymentsCreated: { inc: noop },
  paymentsTransitioned: { inc: noop },
  walletCreditSkipped: { inc: noop },
  duplicateCharges: { inc: noop },
  refundsCreated: { inc: noop },
  earningReversalFailed: { inc: noop },
};
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const wallets = new WalletsService(prisma as never, audit as never, { isEnabled: async () => false } as never);
const cartas = new CartaService(prisma as never, audit as never);
const reports = new ReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, config as never);
const fichas = new StaffFichaService(prisma, moneyMap);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, undefined, moneyMap);
vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, {} as never);
const gateways = { get: () => ({ refund: async () => ({ status: 'SUCCEEDED', providerRefundId: `DEV-${randomUUID().slice(0, 8)}` }) }) };
const refunds = new RefundsService(prisma as never, cls as never, gateways as never, payments as never, {} as never, audit as never, metrics as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** El «ahora» del mapa y de la ficha, un segundo por delante (Postgres puede ir unos ms por delante de Node). */
const soon = () => new Date(Date.now() + 1_000);
/** Que la base apunte lo siguiente después de lo anterior (cerrar una noche y abrir la siguiente). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
let n = 0;
const key = () => `cce-${r}-${(n += 1)}`;

/** Un local con la carta de referencia, Carlos (camarero), Nerea y Lola (chicas), la noche abierta y un saldo con NFC. */
interface Sala {
  V: string;
  owner: string;
  carlos: string;
  nerea: string;
  lola: string;
  copa: string;
  invita: string;
  nightId: string;
  w: { id: string; card: string; uid: string };
}

async function sala(slug: string): Promise<Sala> {
  const s = await sys(async (tx) => {
    const V = (
      await tx.venue.create({
        data: { name: `Sala ${slug}`, slug: `cce-${slug}-${r}`, walletGroup: `gcce-${slug}-${r}`, platformCommissionBps: 0, payoutHoldDays: 0 },
      })
    ).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `CCE-${V.slice(0, 8)}`, label: 'Barra', zone: 'BARRA' } });
    const user = async (role: 'OWNER' | 'WAITER' | 'OPERATOR', name: string) =>
      (await tx.user.create({ data: { tenantId: V, email: `${name.toLowerCase()}-${slug}-${r}@x.es`, passwordHash: 'x', role, displayName: name, ...(role === 'OPERATOR' ? { commissionBps: 9000 } : {}) } })).id;
    const owner = await user('OWNER', 'Dueño');
    const carlos = await user('WAITER', 'Carlos');
    const nerea = await user('OPERATOR', 'Nerea');
    const lola = await user('OPERATOR', 'Lola');
    const nightId = (await tx.venueNight.create({ data: { tenantId: V, openedAt: ago(2 * HOUR), openingFloatCents: 10_000, openedBy: owner } })).id;
    const card = randomBytes(16).toString('base64url');
    const uid = randomBytes(7).toString('hex').toUpperCase();
    const wallet = await tx.clientWallet.create({
      data: { tenantId: V, qrToken: `cce-${slug}-${r}-abcdefgh`, balanceCents: 10_000, status: 'ACTIVE', shortCode: randomBytes(3).toString('hex').toUpperCase(), walletGroup: `gcce-${slug}-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: wallet.id, status: 'ISSUED', venueId: V } });
    return { V, owner, carlos, nerea, lola, nightId, w: { id: wallet.id, card, uid } };
  });
  await inVenue(s.V, () => cartas.applyTemplate(s.V, s.owner, { confirm: true }));
  const items = await inVenue(s.V, () => cartas.listForStaff(s.V, 'WAITER', s.carlos));
  return { ...s, copa: items.find((i) => i.name === 'Copa')!.id, invita: items.find((i) => i.name === 'Copa con invitación')!.id };
}

const qrOf = (s: Sala, userId: string) =>
  `https://operator.local/?invita=${signStaffToken({ userId, tenantId: s.V }, Date.now(), process.env.JWT_SECRET!).token}`;
const carlosActor = (s: Sala) => ({ userId: s.carlos, role: 'WAITER' as const, tenantId: s.V });

/** El cobro de «Cobrar» que hace Carlos: líneas de la carta y, enlazado, el del saldo (como la app). */
const cobro = (s: Sala, lines: Array<{ serviceItemId: string; qty?: number }>, extra: Record<string, unknown> = {}) =>
  inVenue(s.V, () =>
    payments.create(
      s.V,
      key(),
      { currency: 'EUR', terminalExternalId: `CCE-${s.V.slice(0, 8)}`, lines: lines.map((l) => ({ qty: 1, ...l })), withSaldo: true, ...extra } as never,
      { userId: s.carlos, role: 'WAITER' },
    ),
  );

/** Pagado con tarjeta en el banco (Redsys), con la propina que cobró el banco. */
async function paidByCard(s: Sala, paymentId: string, amountCents: number, tipCents = 0): Promise<void> {
  const order = `CE${randomBytes(4).toString('hex')}`;
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({ data: { paymentId, tenantId: s.V, provider: 'REDSYS', providerTxId: order, amountCents: amountCents + tipCents, tipCents } });
  });
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

const refund = (s: Sala, paymentId: string, amountCents: number) =>
  inVenue(s.V, () =>
    refunds.refund({ paymentId, amountCents, reason: 'No era su copa', idempotencyKey: randomUUID() }, { userId: s.owner, role: 'OWNER', tenantId: s.V } as never),
  );
const live = (s: Sala): Promise<MoneyMap> => inVenue(s.V, () => moneyMap.forQuery(s.V, {}, soon()));
const fichaOf = (s: Sala, who: string) => inVenue(s.V, () => fichas.ficha(s.V, who, soon()));
const zOf = async (s: Sala) => (await inVenue(s.V, () => nights.current(s.V)))!.z.summary;
const earningsOf = (paymentId: string) =>
  sys((tx) => tx.operatorEarning.findMany({ where: { paymentId }, orderBy: { commissionCents: 'desc' } }));
const csvLines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

/** Lo de las chicas en el mapa = lo suyo en sus fichas (la regla que se rompía). */
async function fichasCuadran(s: Sala, m: MoneyMap): Promise<void> {
  const [nerea, lola] = await Promise.all([fichaOf(s, s.nerea), fichaOf(s, s.lola)]);
  expect(nerea.stats.shareCents + lola.stats.shareCents).toBe(m.split.chicasCents);
}

beforeAll(async () => {
  await prisma.onModuleInit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('dos chicas: una invitación para cada una', () => {
  let s: Sala;
  beforeAll(async () => {
    s = await sala('dos');
  });

  it('un cobro lleva una sola invitada: el QR de una y la otra de la lista, a la vez, no vale', () => {
    const both = CreatePaymentSchema.safeParse({
      currency: 'EUR', terminalExternalId: 'CCE-1', lines: [{ serviceItemId: randomUUID(), qty: 2 }],
      invitedStaffToken: 'x'.repeat(40), invitedOperatorId: randomUUID(),
    });
    expect(both.success).toBe(false);
  });

  it('dos invitaciones la misma noche (Nerea con tarjeta, Lola con el NFC): cada una, su mitad; todo cuadra', async () => {
    const a = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.nerea) });
    await paidByCard(s, a.id, 2_000);
    const b = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.lola) });
    await inVenue(s.V, () => charges.payQrChargeWithCard(carlosActor(s), b.saldo!.chargeId, { card: s.w.card, uid: s.w.uid }));
    const m = await live(s);
    expect(m.split).toMatchObject({ chicasCents: 2_000, camarerosCents: 0, venueCents: 2_000 });
    const [fn, fl] = await Promise.all([fichaOf(s, s.nerea), fichaOf(s, s.lola)]);
    expect(fn.rows.map((x) => [x.kind, x.title, x.shareCents])).toEqual([['PAYMENT', 'Invitación', 1_000]]);
    expect(fl.rows.map((x) => [x.kind, x.title, x.shareCents])).toEqual([['SALDO', 'Invitación', 1_000]]);
    await fichasCuadran(s, m);
    const z = await zOf(s);
    expect(z).toMatchObject({ chicaNetCents: 2_000, camareroNetCents: 0 });
    expect(z.perChica.map((c) => [c.name, c.count, c.chargedCents, c.netCents])).toEqual([
      ['Lola', 1, 2_000, 1_000],
      ['Nerea', 1, 2_000, 1_000],
    ]);
  });

  it('un cobro con una línea para cada una (la contabilidad va por línea): una ganancia cada una y la devolución, a medias', async () => {
    const c = await cobro(s, [{ serviceItemId: s.invita }, { serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.nerea) });
    // La API pone la misma invitada en todas las líneas; aquí la segunda es de Lola.
    await sys(async (tx) => {
      const lines = await tx.paymentLine.findMany({ where: { paymentId: c.id }, orderBy: { id: 'asc' } });
      expect(lines.map((l) => [l.beneficiaryOperatorId, l.beneficiaryCents, l.chargerCents])).toEqual([
        [s.nerea, 1_000, 0],
        [s.nerea, 1_000, 0],
      ]);
      await tx.paymentLine.update({ where: { id: lines[1]!.id }, data: { beneficiaryOperatorId: s.lola } });
    });
    await paidByCard(s, c.id, 4_000);
    expect((await earningsOf(c.id)).map((e) => [e.operatorId, e.commissionCents, e.paymentAmountCents]).sort()).toEqual(
      [
        [s.lola, 1_000, 2_000],
        [s.nerea, 1_000, 2_000],
      ].sort(),
    );
    await refund(s, c.id, 2_000);
    expect((await earningsOf(c.id)).map((e) => e.reversedCents)).toEqual([500, 500]);
    const m = await live(s);
    // Las de antes (20 €) y esta (20 € − 10 € devueltos): lo de las chicas, 20 + 10.
    expect(m.split.chicasCents).toBe(3_000);
    await fichasCuadran(s, m);
    expect(await zOf(s)).toMatchObject({ chicaNetCents: 3_000, chicaReversalsCents: 1_000 });
    const row = csvLines(cobrosCsv(await inVenue(s.V, () => reports.cobros(s.V, { from: ago(3 * HOUR), to: soon() })), 'Sala'))
      .find((l) => l.includes(';40,00;0,00;40,00;20,00;20,00;'))!;
    // Parte chica: las dos (10 €), camarero 0 €, local 10 €.
    expect(row).toContain(';40,00;0,00;40,00;20,00;20,00;10,00;0,00;10,00;Devuelto en parte;');
  });
});

describe('invitación con propina', () => {
  let s: Sala, pay: string;
  beforeAll(async () => {
    s = await sala('propina');
    const c = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.nerea), tipCents: 200 });
    await paidByCard(s, c.id, 2_000, 200);
    pay = c.id;
  });

  it('la chica se lleva su mitad de la copa (no de la propina); la propina, del local (la cobró el camarero)', async () => {
    const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: pay } }));
    expect(p).toMatchObject({ amountCents: 2_000, tipCents: 200 });
    expect((await earningsOf(pay)).map((e) => [e.operatorId, e.commissionCents, e.tipCents])).toEqual([[s.nerea, 1_000, 0]]);
    const m = await live(s);
    expect(m.salesCents).toBe(2_200);
    expect(m.split).toMatchObject({ chicasCents: 1_000, camarerosCents: 0, venueCents: 1_200 });
    await fichasCuadran(s, m);
    expect(await zOf(s)).toMatchObject({ netCents: 2_200, chicaNetCents: 1_000, venueNetCents: 1_200 });
    const row = csvLines(cobrosCsv(await inVenue(s.V, () => reports.cobros(s.V, { from: ago(3 * HOUR), to: soon() })), 'Sala'))
      .find((l) => l.includes(';Copa con invitación;'))!;
    expect(row).toContain(';20,00;2,00;22,00;0,00;22,00;10,00;0,00;12,00;Pagado;');
  });

  it('devolver la mitad (11 €) le quita la mitad de lo suyo; devolverlo todo, todo', async () => {
    await refund(s, pay, 1_100);
    expect((await earningsOf(pay))[0]).toMatchObject({ commissionCents: 1_000, reversedCents: 500 });
    let m = await live(s);
    expect(m.split.chicasCents).toBe(500);
    await fichasCuadran(s, m);
    await refund(s, pay, 1_100);
    expect((await earningsOf(pay))[0]).toMatchObject({ reversedCents: 1_000 });
    m = await live(s);
    // Lo vendido se reparte igual (la chica, ya nada); los 22 € devueltos salen del local («Qué sale»).
    expect(m.split).toMatchObject({ chicasCents: 0, venueCents: 2_200 });
    expect(m.outflow.refunds).toMatchObject({ cardCents: 2_200, cardCount: 2 });
    await fichasCuadran(s, m);
    expect(await zOf(s)).toMatchObject({ refundsCents: 2_200, chicaNetCents: 0, venueNetCents: 0 });
  });
});

describe('devolución en parte otra noche (y después de pagar a la chica)', () => {
  let s: Sala, anoche: string, nightTwo: string;
  beforeAll(async () => {
    s = await sala('otra');
    // Noche 1: la invitación de Nerea, pagada con tarjeta; se cierra la noche.
    const a = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.nerea) });
    await paidByCard(s, a.id, 2_000);
    anoche = a.id;
    const check = await inVenue(s.V, () => nights.closeCheck(s.V));
    const acknowledged = check.steps.filter((x) => x.status !== 'ok').map((x) => x.key);
    await inVenue(s.V, () =>
      nights.close(s.V, { userId: s.owner, role: 'OWNER' }, s.nightId, { cashCountedCents: check.cash.expectedCents, acknowledged, note: 'noche 1' }),
    );
    await tick();
    nightTwo = (await sys((tx) => tx.venueNight.create({ data: { tenantId: s.V, openedAt: new Date(), openingFloatCents: 10_000, openedBy: s.owner } }))).id;
    await tick();
  });

  it('esta noche: una invitación nueva y la devolución de 10 € de la de anoche: Nerea 10 € − 5 €, en el mapa, su ficha y el Z', async () => {
    const b = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.nerea) });
    await paidByCard(s, b.id, 2_000);
    await refund(s, anoche, 1_000);
    const m = await live(s);
    expect(m.scope).toEqual({ kind: 'night', nightId: nightTwo, open: true });
    expect(m.split.chicasCents).toBe(500);
    const f = await fichaOf(s, s.nerea);
    expect(f.rows.map((x) => [x.title, x.amountCents, x.shareCents, Boolean(x.refundOf)])).toEqual([
      ['Devolución', 1_000, -500, true],
      ['Invitación', 2_000, 1_000, false],
    ]);
    // Lo vendido esta noche es la copa de hoy; lo suyo, lo de hoy menos lo descontado.
    expect(f.stats).toMatchObject({ soldCents: 2_000, shareCents: 500, count: 1 });
    await fichasCuadran(s, m);
    expect(await zOf(s)).toMatchObject({ refundsCents: 1_000, chicaReversalsCents: 500, chicaNetCents: 500 });
    // La noche de anoche, congelada, no cambia.
    const night1 = await sys((tx) => tx.venueNight.findUniqueOrThrow({ where: { id: s.nightId } }));
    expect((night1.zReport as { summary: { chicaNetCents: number } }).summary.chicaNetCents).toBe(1_000);
  });

  it('ya pagada y devuelta después: lo que debe se resta en su ficha como en el mapa', async () => {
    const c = await cobro(s, [{ serviceItemId: s.invita }], { invitedStaffToken: qrOf(s, s.lola) });
    await paidByCard(s, c.id, 2_000);
    await inVenue(s.V, () => operators.createPayout(s.V, s.lola, s.owner, 'esta noche', { externalRail: 'MANUAL_CASH' }));
    await refund(s, c.id, 1_000);
    const [earning] = await earningsOf(c.id);
    expect(earning).toMatchObject({ commissionCents: 1_000, reversedCents: 0 });
    expect(earning!.payoutId).not.toBeNull();
    const m = await live(s);
    const f = await fichaOf(s, s.lola);
    expect(f.rows.map((x) => [x.title, x.shareCents])).toEqual([['Invitación', 500]]);
    expect(f.stats).toMatchObject({ shareCents: 500, paidCents: 1_000 });
    // Nerea 5 € + Lola 5 €.
    expect(m.split.chicasCents).toBe(1_000);
    await fichasCuadran(s, m);
    expect(await zOf(s)).toMatchObject({ chicaNetCents: 1_000 });
  });
});

describe('invitación del saldo con el NFC del cliente (sin tarjeta)', () => {
  let s: Sala, chargeId: string;
  beforeAll(async () => {
    s = await sala('nfc');
    const created = await inVenue(s.V, () =>
      charges.createQrCharge(carlosActor(s), { lines: [{ serviceItemId: s.invita, qty: 1 }], invitedStaffToken: qrOf(s, s.nerea) }),
    );
    chargeId = created.id;
    await inVenue(s.V, () => charges.payQrChargeWithCard(carlosActor(s), chargeId, { card: s.w.card, uid: s.w.uid }));
  });

  it('la línea lleva a Nerea y su mitad; sale del saldo y se ve en el mapa, su ficha y el Z', async () => {
    const line = await sys((tx) => tx.paymentLine.findFirstOrThrow({ where: { walletChargeId: chargeId } }));
    expect(line).toMatchObject({ amountCents: 2_000, beneficiaryOperatorId: s.nerea, beneficiaryCents: 1_000, chargerCents: 0 });
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: s.w.id } }));
    expect(wallet.balanceCents).toBe(8_000);
    const m = await live(s);
    expect(m.inflow).toMatchObject({ cardCents: 0, saldoCents: 2_000 });
    expect(m.split).toMatchObject({ chicasCents: 1_000, venueCents: 1_000 });
    const f = await fichaOf(s, s.nerea);
    expect(f.rows.map((x) => [x.kind, x.title, x.via, x.chargedBy?.name, x.shareCents])).toEqual([['SALDO', 'Invitación', 'NFC sin PIN', 'Carlos', 1_000]]);
    await fichasCuadran(s, m);
    const z = await zOf(s);
    expect(z.saldoByType.reduce((a, t) => a + t.chargedCents, 0)).toBe(2_000);
    expect(z).toMatchObject({ chicaNetCents: 1_000 });
  });

  it('anular el consumo devuelve el saldo y le quita su parte', async () => {
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { idempotencyKey: `charge-request:${chargeId}` } }));
    await inVenue(s.V, () =>
      wallets.reverseConsumption({ tenantId: s.V, walletId: s.w.id, consumptionId: consumption.id, actorUserId: s.owner, actorRole: 'OWNER', reason: 'No era para ella' }),
    );
    const m = await live(s);
    expect(m.split).toMatchObject({ chicasCents: 0, venueCents: 0 });
    await fichasCuadran(s, m);
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: s.w.id } }));
    expect(wallet.balanceCents).toBe(10_000);
  });
});
