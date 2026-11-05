// Integración (Postgres real, np_app con FORCE RLS): la contabilidad de una
// «Copa con invitación» de 20 € que cobra el camarero, una con tarjeta y otra
// con el saldo (NFC), junto a 2 copas normales con propina. En TODAS las vistas
// cuadra: lo del local (10 € de cada una) va a Copas como suyo; lo de la chica
// (10 €) es suyo (se le debe) y se ve en su ficha, en «Mi noche» y en sus
// invitaciones; el camarero consta como quien cobró, sin parte propia; local +
// chicas + propinas = lo cobrado. Las devoluciones (en parte y del todo) y el
// consumo anulado le quitan su parte en proporción. Y un local que da una
// parte al camarero (la eligió en Ajustes) la mantiene y los informes la restan
// de lo del local. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema, MONEY_MAP_TIPS, type JwtPayload, type MoneyMap } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { OwnCobrosController } from '../../src/modules/money-map/own-cobros.controller';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { cobrosCsv, devolucionesCsv, resumenCsv, summarize } from '../../src/modules/reports/export-csv';
import { parseReportPeriod } from '../../src/modules/reports/report-period';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
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
const wallets = new WalletsService(prisma as never, audit as never, { isEnabled: async () => true, assertForUser: async () => undefined } as never);
const carta = new CartaService(prisma as never, audit as never);
const cobros = new CobrosService(prisma);
const reports = new ReportsService(prisma);
const period = new PeriodReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, config as never);
const fichas = new StaffFichaService(prisma, moneyMap);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, undefined, moneyMap);
// La noche se abre «hace 2 h»: que el cierre automático de las 08:00 no se cruce con la prueba.
vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
// El banco devuelve lo que se le pide (Redsys de mentira).
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
/** El «ahora» del mapa, un segundo por delante (la hora de Postgres puede ir unos ms por delante de la de Node). */
const soon = () => new Date(Date.now() + 1_000);
let V: string, owner: string, carlos: string, nerea: string, copa: string, invita: string, nightId: string;
let w: { id: string; card: string; uid: string };
let p1: string, p2: { id: string; chargeId: string };
let n = 0;
const key = () => `cci-${r}-${(n += 1)}`;
const carlosActor = () => ({ userId: carlos, role: 'WAITER' as const, tenantId: V });
const ownerActor = () => ({ userId: owner, role: 'OWNER' as const, tenantId: V });
const qrOf = (userId: string, tenantId = V) =>
  `https://operator.local/?invita=${signStaffToken({ userId, tenantId }, Date.now(), process.env.JWT_SECRET!).token}`;

/** El cobro de «Cobrar»: líneas de la carta y, enlazado, el del saldo (como la app). */
const cobro = (tenantId: string, userId: string, lines: Array<{ serviceItemId: string; qty?: number }>, extra: Record<string, unknown> = {}) =>
  inVenue(tenantId, () =>
    payments.create(
      tenantId,
      key(),
      { currency: 'EUR', terminalExternalId: `CCI-${tenantId.slice(0, 8)}`, lines: lines.map((l) => ({ qty: 1, ...l })), withSaldo: true, ...extra } as never,
      { userId, role: 'WAITER' },
    ),
  );

/** Pagado con tarjeta en el banco (Redsys). */
async function paidByCard(tenantId: string, paymentId: string, amountCents: number): Promise<void> {
  const order = `CC${randomBytes(4).toString('hex')}`;
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({ data: { paymentId, tenantId, provider: 'REDSYS', providerTxId: order, amountCents, tipCents: 0 } });
  });
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

const refund = (paymentId: string, amountCents: number) =>
  inVenue(V, () => refunds.refund({ paymentId, amountCents, reason: 'No era su copa', idempotencyKey: randomUUID() }, ownerActor()));
const live = () => inVenue(V, () => moneyMap.forQuery(V, {}, soon()));
const reportWindow = () => ({ from: ago(3 * HOUR), to: soon() });
const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (
      await tx.venue.create({
        data: { name: 'Sala Copas', slug: `cci-${r}`, walletGroup: `gcci-${r}`, platformCommissionBps: 0, payoutHoldDays: 0 },
      })
    ).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `CCI-${V.slice(0, 8)}`, label: 'Barra', zone: 'BARRA' } });
    owner = (await tx.user.create({ data: { tenantId: V, email: `own-cci-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    carlos = (
      await tx.user.create({ data: { tenantId: V, email: `carlos-cci-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Carlos' } })
    ).id;
    nerea = (
      await tx.user.create({
        data: { tenantId: V, email: `nerea-cci-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Nerea' },
      })
    ).id;
    nightId = (await tx.venueNight.create({ data: { tenantId: V, openedAt: ago(2 * HOUR), openingFloatCents: 10_000, openedBy: owner } })).id;
    // El saldo del cliente: 50 € recargados con tarjeta, con su NFC.
    const card = randomBytes(16).toString('base64url');
    const uid = randomBytes(7).toString('hex').toUpperCase();
    const wallet = await tx.clientWallet.create({
      data: { tenantId: V, qrToken: `cci-${r}-abcdefgh`, balanceCents: 5_000, status: 'ACTIVE', shortCode: `K${r.slice(0, 5)}`.toUpperCase(), walletGroup: `gcci-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: wallet.id, status: 'ISSUED', venueId: V } });
    w = { id: wallet.id, card, uid };
    const term = await tx.terminal.findFirstOrThrow({ where: { tenantId: V } });
    await tx.payment.create({
      data: {
        tenantId: V, terminalId: term.id, idempotencyKey: key(), amountCents: 5_000, availableAmountCents: 5_000, qrToken: `cci-q-${r}-1`,
        qrExpiresAt: ago(-HOUR), status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `CCT${r}`, walletId: wallet.id, captureMethod: 'WALLET_TOPUP',
        revenueCategory: 'EXTRA', createdAt: ago(90 * 60_000), authorizedAt: ago(90 * 60_000),
      },
    });
  });
  // La carta de referencia, como la aplicaría el dueño.
  await inVenue(V, () => carta.applyTemplate(V, owner, { confirm: true }));
  const items = await inVenue(V, () => carta.listForStaff(V, 'WAITER', carlos));
  copa = items.find((i) => i.name === 'Copa')!.id;
  invita = items.find((i) => i.name === 'Copa con invitación')!.id;

  // Carlos cobra: una copa con invitación con tarjeta, otra con el NFC del cliente y 2 copas con 2 € de propina (Face ID).
  const a = await cobro(V, carlos, [{ serviceItemId: invita }], { invitedStaffToken: qrOf(nerea) });
  await paidByCard(V, a.id, 2_000);
  p1 = a.id;
  const b = await cobro(V, carlos, [{ serviceItemId: invita }], { invitedStaffToken: qrOf(nerea) });
  await inVenue(V, () => charges.payQrChargeWithCard(carlosActor(), b.saldo!.chargeId, { card: w.card, uid: w.uid }));
  p2 = { id: b.id, chargeId: b.saldo!.chargeId };
  const c = await cobro(V, carlos, [{ serviceItemId: copa, qty: 2 }], { tipCents: 200 });
  const payToken = (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId } }))).payToken!;
  await inVenue(undefined, () => charges.payQrCharge(payToken, w.id));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la carta y el cobro', () => {
  it('«Copa» y justo detrás «Copa con invitación» (20 €), en Copas', async () => {
    const items = await inVenue(V, () => carta.listForStaff(V, 'WAITER', carlos));
    expect(items.slice(0, 2).map((i) => [i.name, i.priceCents, i.category, i.isInvitation])).toEqual([
      ['Copa', 1000, 'VENUE_BAR', false],
      ['Copa con invitación', 2000, 'VENUE_BAR', true],
    ]);
    expect(items.map((i) => i.name)).not.toContain('Copa premium');
  });

  it('cada invitación: la línea lleva a Nerea y su mitad; al camarero, nada (de fábrica)', async () => {
    const card = await sys((tx) => tx.paymentLine.findMany({ where: { paymentId: p1 } }));
    const saldo = await sys((tx) => tx.paymentLine.findMany({ where: { walletChargeId: p2.chargeId } }));
    for (const l of [...card, ...saldo]) {
      expect(l).toMatchObject({ category: 'VENUE_BAR', amountCents: 2000, beneficiaryOperatorId: nerea, beneficiaryCents: 1000, chargerCents: 0 });
    }
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { idempotencyKey: `charge-request:${p2.chargeId}` } }));
    const earnings = await sys((tx) =>
      tx.operatorEarning.findMany({ where: { OR: [{ paymentId: p1 }, { consumptionId: consumption.id }, { operatorId: carlos }] } }),
    );
    expect(earnings.map((e) => [e.operatorId, e.commissionCents, e.paymentAmountCents])).toEqual([
      [nerea, 1000, 2000],
      [nerea, 1000, 2000],
    ]);
  });
});

describe('esta noche, antes de devolver nada: todas las vistas cuadran', () => {
  let m: MoneyMap;
  beforeAll(async () => {
    m = await live();
  });

  it('mapa del dinero: lo de la chica no es del local; local + chicas = lo vendido (con la propina, del local)', () => {
    expect(m.scope).toEqual({ kind: 'night', nightId, open: true });
    expect(m.inflow).toMatchObject({ cardCents: 2000, saldoCents: 4200, topUps: { totalCents: 5000, cardCents: 5000, cashCents: 0, count: 1 } });
    expect(m.salesCents).toBe(6200);
    const by = Object.fromEntries(m.sections.map((s) => [s.code, s.amountCents]));
    expect(by).toMatchObject({ VENUE_BAR: 6000, [MONEY_MAP_TIPS]: 200, CHICA_SERVICE: 0 });
    // Copas: 10 € de cada invitación + las 2 copas = 40 €, y 2 € de propina: del local. Nerea: 20 €. El camarero: nada.
    expect(m.split).toMatchObject({ venueCents: 4200, chicasCents: 2000, camarerosCents: 0, commissions: { platformCents: 0, bankCents: null, totalCents: 0 } });
    expect(m.split.venueCents + m.split.chicasCents + m.split.camarerosCents + m.split.commissions.totalCents).toBe(m.salesCents);
    // Se le debe a Nerea; es dinero que está en el banco y en el saldo, no del local.
    expect(m.where.owners).toEqual({ staffCents: 2000, saldoCents: 800, paidOutCents: 0, commissionsCents: 0, venueCents: 7000 + 10_000 - 2000 - 800 });
    expect(m.where.owed).toEqual({ chicasCents: 2000, camarerosCents: 0, bankHeldCents: 0 });
    expect(m.outflow.pendingStaff).toEqual({ chicasCents: 2000, camarerosCents: 0 });
  });

  it('la ficha de Nerea: sus dos invitaciones (las cobró Carlos), 10 € cada una = lo de las chicas en el mapa', async () => {
    const f = await inVenue(V, () => fichas.ficha(V, nerea, soon()));
    expect(f.rows.map((x) => [x.title, x.kind, x.section, x.amountCents, x.shareCents, x.chargedBy?.name ?? null, x.invitation, x.undone])).toEqual([
      ['Invitación', 'SALDO', 'VENUE_BAR', 2000, 1000, 'Carlos', true, false],
      ['Invitación', 'PAYMENT', 'VENUE_BAR', 2000, 1000, 'Carlos', true, false],
    ]);
    expect(f.stats).toEqual({ soldCents: 4000, shareCents: m.split.chicasCents, paidCents: 0, count: 2 });
    expect(f.rates).toEqual(expect.arrayContaining([{ kind: 'invitation', share: { kind: 'PERCENT', bps: 5000 } }]));
  });

  it('el camarero consta como quien cobró (sus cobros), sin ganancia propia', async () => {
    const f = await inVenue(V, () => fichas.ficha(V, carlos, soon()));
    expect(f.person.role).toBe('WAITER');
    expect(f.rows).toEqual([]);
    expect(f.rates).toEqual([]);
    expect(f.stats.shareCents).toBe(m.split.camarerosCents);
    const own = new OwnCobrosController(cobros, moneyMap);
    const page = await inVenue(V, () => own.list({ sub: carlos, tenantId: V, role: 'WAITER' } as JwtPayload, { limit: 50 }));
    const paid = page.items.filter((i) => i.status === 'AUTHORIZED' || i.status === 'ACCEPTED');
    expect(paid.filter((i) => i.invitedName === 'Nerea').map((i) => [i.kind, i.amountCents])).toEqual(
      expect.arrayContaining([
        ['PAYMENT', 2000],
        ['SALDO', 2000],
      ]),
    );
    expect(paid.find((i) => i.kind === 'SALDO' && !i.invitedName)).toMatchObject({ amountCents: 2000, tipCents: 200 });
  });

  it('sus invitaciones: en su ficha (2 copas, 40 €, su parte 20 €), en «Mi noche» y en la lista de cobros', async () => {
    expect(await inVenue(V, () => cobros.invitationSummary(V, nerea))).toEqual({ count: 2, amountCents: 4000, shareCents: 2000 });
    const mine = await inVenue(V, () => nights.mine(V, nerea));
    expect(mine).toMatchObject({ count: 2, chargedCents: 2000, commissionCents: 2000, netCents: 2000, unpaidCents: 2000 });
    expect(mine.invitations).toEqual({ count: 2, shareCents: 2000 });
    const page = await inVenue(V, () => cobros.list(V, CobrosQuerySchema.parse({ invitedOperatorId: nerea, limit: 50 })));
    const paid = page.items.filter((i) => i.status === 'AUTHORIZED' || i.status === 'ACCEPTED');
    expect(paid).toHaveLength(2);
    expect(paid.every((i) => i.person?.name === 'Carlos' && i.invited?.name === 'Nerea')).toBe(true);
  });

  it('el Z de la noche: lo de las chicas es suyo; lo del local, el resto (y lo mismo por chica)', async () => {
    const view = await inVenue(V, () => nights.current(V));
    const s = view!.z.summary;
    expect(s.byType).toEqual([
      { label: 'Copas', count: 1, chargedCents: 2000 },
      { label: 'Recarga con tarjeta', count: 1, chargedCents: 5000 },
    ]);
    expect(s.saldoByType).toEqual([{ label: 'Copas', count: 2, chargedCents: 4200 }]);
    expect(s).toMatchObject({ netCents: 7000, chicaCommissionCents: 2000, chicaNetCents: 2000, camareroNetCents: 0, venueNetCents: 5000 });
    expect(s.venueNetCents + s.chicaNetCents + (s.camareroNetCents ?? 0)).toBe(s.netCents);
    expect(s.perChica).toEqual([
      { name: 'Nerea', count: 2, chargedCents: 4000, commissionCents: 2000, tipsCents: 0, reversalsCents: 0, netCents: 2000, paidCents: 0 },
    ]);
  });

  it('los CSV de la gestoría: Parte chica 10 €, Parte camarero 0 €, Parte local 10 € (Copas)', async () => {
    const rows = await inVenue(V, () => reports.cobros(V, reportWindow()));
    const csv = lines(cobrosCsv(rows, 'Sala Copas'));
    const row = csv.find((l) => l.includes(';Copa con invitación;'))!;
    expect(row).toContain(';Barra;Carlos;');
    expect(row).toContain(';20,00;0,00;20,00;0,00;20,00;10,00;0,00;10,00;Pagado;');
    expect(row).toMatch(/;Barra 20,00$/);
    const [consumos, devoluciones, liquidaciones] = await Promise.all([
      inVenue(V, () => reports.consumos(V, reportWindow())),
      inVenue(V, () => reports.devoluciones(V, reportWindow())),
      inVenue(V, () => reports.liquidaciones(V, reportWindow())),
    ]);
    const s = summarize(rows, devoluciones, liquidaciones, consumos);
    const parsed = parseReportPeriod('2026-10-01', '2026-10-31');
    if (!parsed.ok) throw new Error(parsed.error);
    const resumen = resumenCsv({ venueName: 'Sala Copas', period: parsed.period, generatedAt: new Date(), summary: s });
    expect(resumen).toContain('Comisión de las chicas;20,00');
    expect(resumen).toContain('Total para las chicas;20,00');
    expect(resumen).toContain('Total para el local;50,00');
    expect(resumen).not.toContain('camareros');
    expect(resumen).toContain('Nerea;2;40,00;20,00;0,00;0,00;20,00;0,00');
  });

  it('el Z del periodo: Copas por línea, con las del saldo; lo del personal, aparte', async () => {
    const z = await inVenue(V, () => period.periodZ(V, reportWindow()));
    expect(z.byRevenueCategory).toEqual([
      expect.objectContaining({ category: 'VENUE_BAR', grossCents: 6000, tipCents: 200, paymentCents: 2000, consumptionCents: 4000 }),
    ]);
    expect(z.earnings).toEqual({ count: 2, totalNetCents: 2000 });
  });
});

describe('devoluciones: le quitan su parte en proporción, y las vistas siguen cuadrando', () => {
  it('se devuelve la mitad de la de tarjeta: Nerea pierde 5 € (de sus 10 €)', async () => {
    await refund(p1, 1000);
    const card = await sys((tx) => tx.operatorEarning.findFirstOrThrow({ where: { paymentId: p1, operatorId: nerea } }));
    expect(card).toMatchObject({ commissionCents: 1000, reversedCents: 500 });
    expect(await inVenue(V, () => cobros.invitationSummary(V, nerea))).toEqual({ count: 2, amountCents: 4000, shareCents: 1500 });
    expect((await inVenue(V, () => nights.mine(V, nerea))).invitations).toEqual({ count: 2, shareCents: 1500 });
    const f = await inVenue(V, () => fichas.ficha(V, nerea, soon()));
    expect(f.rows.find((x) => x.kind === 'PAYMENT')).toMatchObject({ amountCents: 2000, shareCents: 500, undone: false });
    const m = await live();
    // Lo de Nerea, menos lo descontado: el local devuelve los 10 € y recupera su parte.
    expect(m.split).toMatchObject({ chicasCents: 1500, venueCents: 6200 - 1500 });
    expect(f.stats.shareCents).toBe(m.split.chicasCents);
    expect(m.outflow.refunds).toMatchObject({ cardCents: 1000, cardCount: 1 });
    expect(m.where.owed).toEqual({ chicasCents: 1500, camarerosCents: 0, bankHeldCents: 0 });
    const view = await inVenue(V, () => nights.current(V));
    expect(view!.z.summary).toMatchObject({ refundsCents: 1000, chicaReversalsCents: 500, chicaNetCents: 1500, venueNetCents: 7000 - 1000 - 1500 });
    const rows = await inVenue(V, () => reports.cobros(V, reportWindow()));
    const row = lines(cobrosCsv(rows, 'Sala Copas')).find((l) => l.includes(';Copa con invitación;'))!;
    expect(row).toContain(';20,00;0,00;20,00;10,00;10,00;5,00;0,00;5,00;Devuelto en parte;');
    const dev = lines(devolucionesCsv(await inVenue(V, () => reports.devoluciones(V, reportWindow()))));
    expect(dev[1]).toContain(';Carlos;5,00;No;;');
  });

  it('se devuelve el resto: su parte de esa copa, a cero (ya no cuenta como invitación)', async () => {
    await refund(p1, 1000);
    const card = await sys((tx) => tx.operatorEarning.findFirstOrThrow({ where: { paymentId: p1, operatorId: nerea } }));
    expect(card.reversedCents).toBe(1000);
    expect(await inVenue(V, () => cobros.invitationSummary(V, nerea))).toEqual({ count: 1, amountCents: 2000, shareCents: 1000 });
    const m = await live();
    expect(m.split).toMatchObject({ chicasCents: 1000, venueCents: 5200 });
    expect(m.outflow.refunds).toMatchObject({ cardCents: 2000, cardCount: 2 });
  });

  it('se anula el consumo del NFC: el saldo vuelve al cliente y Nerea pierde esa parte', async () => {
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { idempotencyKey: `charge-request:${p2.chargeId}` } }));
    await inVenue(V, () =>
      wallets.reverseConsumption({ tenantId: V, walletId: w.id, consumptionId: consumption.id, actorUserId: owner, totpCode: '123456', reason: 'No era para ella' }),
    );
    expect(await inVenue(V, () => cobros.invitationSummary(V, nerea))).toEqual({ count: 0, amountCents: 0, shareCents: 0 });
    const mine = await inVenue(V, () => nights.mine(V, nerea));
    expect(mine.invitations).toEqual({ count: 0, shareCents: 0 });
    expect(mine).toMatchObject({ netCents: 0, unpaidCents: 0 });
    const f = await inVenue(V, () => fichas.ficha(V, nerea, soon()));
    expect(f.rows.map((x) => [x.kind, x.shareCents, x.undone])).toEqual([
      ['SALDO', 0, true],
      ['PAYMENT', 0, true],
    ]);
    const m = await live();
    // Quedan: la de tarjeta (devuelta) y las 2 copas con propina del saldo.
    expect(m.inflow).toMatchObject({ cardCents: 2000, saldoCents: 2200 });
    expect(m.split).toMatchObject({ chicasCents: 0, camarerosCents: 0, venueCents: 4200 });
    expect(f.stats.shareCents).toBe(m.split.chicasCents);
    // En el banco 50 € (recarga) + 20 − 20 devueltos; el saldo vivo del cliente: 28 €.
    expect(m.where).toMatchObject({ bbvaCents: 5000, liveSaldoCents: 2800, owed: { chicasCents: 0, camarerosCents: 0 } });
    expect(m.where.owners).toEqual({ staffCents: 0, saldoCents: 2800, paidOutCents: 0, commissionsCents: 0, venueCents: 5000 + 10_000 - 2800 });
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: w.id } }));
    expect(wallet.balanceCents).toBe(2800);
  });
});

describe('al cerrar la noche, el Z congela las mismas cifras', () => {
  it('el mapa congelado es el de en directo y el Z cuadra (lo de Nerea, a cero tras devolver y anular)', async () => {
    const before = await live();
    const check = await inVenue(V, () => nights.closeCheck(V));
    const acknowledged = check.steps.filter((s) => s.status !== 'ok').map((s) => s.key);
    await inVenue(V, () =>
      nights.close(V, { userId: owner, role: 'OWNER' }, nightId, { cashCountedCents: check.cash.expectedCents, acknowledged, note: 'copa con invitación' }),
    );
    const frozen = await inVenue(V, () => moneyMap.forQuery(V, { night: nightId }));
    expect(frozen.frozen).toBe(true);
    const strip = (m: MoneyMap) => ({ ...m, scope: null, frozen: null, generatedAt: null, to: null });
    expect(strip(frozen)).toEqual(strip(before));
    expect(frozen.split).toMatchObject({ chicasCents: 0, camarerosCents: 0, venueCents: 4200 });
    const night = await sys((tx) => tx.venueNight.findUniqueOrThrow({ where: { id: nightId } }));
    const z = night.zReport as unknown as { summary: { chicaNetCents: number; camareroNetCents?: number; venueNetCents: number; netCents: number } };
    expect(z.summary.chicaNetCents).toBe(0);
    expect(z.summary.camareroNetCents).toBe(0);
    expect(z.summary.venueNetCents).toBe(z.summary.netCents);
  });
});

describe('un local que da una parte al camarero (la eligió en Ajustes)', () => {
  let V2: string, dani: string, lola: string, inv2: string, pay: string;
  beforeAll(async () => {
    await sys(async (tx) => {
      V2 = (
        await tx.venue.create({
          data: {
            name: 'Sala Antigua',
            slug: `cci2-${r}`,
            platformCommissionBps: 0,
            // Lo que eligió: la mitad para la chica y la mitad para el camarero (con la clave «Invitar» primero, de antes).
            invitationRules: { chica: { kind: 'PERCENT', bps: 5000 }, camarero: { kind: 'PERCENT', bps: 5000 }, inviteFirst: true, requireQr: true },
          },
        })
      ).id;
      await tx.terminal.create({ data: { tenantId: V2, externalId: `CCI-${V2.slice(0, 8)}`, label: 'Barra' } });
      dani = (await tx.user.create({ data: { tenantId: V2, email: `dani-cci-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani' } })).id;
      lola = (
        await tx.user.create({ data: { tenantId: V2, email: `lola-cci-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' } })
      ).id;
      await tx.venueNight.create({ data: { tenantId: V2, openedAt: ago(2 * HOUR), openedBy: dani } });
      inv2 = (await tx.serviceItem.create({ data: { tenantId: V2, name: 'Copa con invitación', priceCents: 2000, category: 'VENUE_BAR', isInvitation: true } })).id;
    });
    const c = await cobro(V2, dani, [{ serviceItemId: inv2 }], { invitedStaffToken: qrOf(lola, V2) });
    await paidByCard(V2, c.id, 2000);
    pay = c.id;
  });

  it('se respeta: la chica 10 € y el camarero 10 €; el local, nada de esa copa', async () => {
    const earnings = await sys((tx) => tx.operatorEarning.findMany({ where: { paymentId: pay }, orderBy: { createdAt: 'asc' } }));
    expect(earnings.map((e) => [e.operatorId, e.commissionCents]).sort()).toEqual([[dani, 1000], [lola, 1000]].sort());
    const m = await inVenue(V2, () => moneyMap.forQuery(V2, {}, soon()));
    expect(m.split).toMatchObject({ chicasCents: 1000, camarerosCents: 1000, venueCents: 0 });
    const f = await inVenue(V2, () => fichas.ficha(V2, dani, soon()));
    expect(f.rows).toEqual([expect.objectContaining({ title: 'Invitación', shareCents: 1000 })]);
    expect(f.rates).toEqual([{ kind: 'invitation', share: { kind: 'PERCENT', bps: 5000 } }]);
  });

  it('los informes restan la parte del camarero de lo del local (antes se quedaba en «Parte local»)', async () => {
    const rows = await inVenue(V2, () => reports.cobros(V2, reportWindow()));
    const row = lines(cobrosCsv(rows, 'Sala Antigua')).find((l) => l.includes(';Copa con invitación;'))!;
    expect(row).toContain(';20,00;0,00;20,00;0,00;20,00;10,00;10,00;0,00;Pagado;');
    const view = await inVenue(V2, () => nights.current(V2));
    expect(view!.z.summary).toMatchObject({ netCents: 2000, chicaNetCents: 1000, camareroNetCents: 1000, venueNetCents: 0 });
    expect(view!.z.summary.perChica.map((c) => c.name)).toEqual(['Lola']);
  });
});
