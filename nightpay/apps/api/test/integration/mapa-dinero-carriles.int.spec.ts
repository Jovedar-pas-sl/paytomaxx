// Integración (Postgres real, np_app con FORCE RLS): el mapa del dinero de una
// noche (los cinco carriles) cuadra consigo mismo y con el Z: lo que entra por
// canal = lo vendido por sección = lo repartido; BBVA + caja = lo de cada
// dueño; el saldo vivo de los clientes = recargas − consumos − devuelto. Al
// cerrar se congela en el Z. El Z y el Z del periodo suman por línea. Y la
// parte del camarero en las invitaciones se paga como la de las chicas. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { MONEY_MAP_TIPS, venueEarnedCents, type MoneyMap } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { OwnCobrosController } from '../../src/modules/money-map/own-cobros.controller';
import type { JwtPayload } from '@nightpay/contracts';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { WalletFichaService } from '../../src/modules/money-map/wallet-ficha.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { metricsPeriod } from '../../src/modules/reports/period-reports';
import { chargedCents, chargedParts } from '../../src/modules/reports/period-totals';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import type { NightZ } from '../../src/modules/nights/night-rules';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { ApprovalRequestsService } from '../../src/modules/approvals/approval-requests.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const config = { get: () => undefined, getOrThrow: () => undefined };
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
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const carta = new CartaService(prisma as never, audit as never);
const reports = new ReportsService(prisma);
const period = new PeriodReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, config as never);
const staffFichas = new StaffFichaService(prisma, moneyMap);
const walletFichas = new WalletFichaService(prisma);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, undefined, moneyMap);
// La noche se abre «hace 2 h»: que el cierre automático de las 08:00 no se cruce con la prueba.
vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, {} as never, {} as never);
const requests = new ApprovalRequestsService(prisma, audit as never, config as never, { enabled: () => false, requested: vi.fn() } as never);

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
// La hora de la base (now() de Postgres) puede ir unos ms por delante de la de
// Node: el mapa «en directo» se pide con un ahora un segundo por delante.
const soon = () => new Date(Date.now() + 1_000);
let A: string, owner: string, manager: string, lola: string, dani: string, term: string, W: string, nightId: string;
let copa: string, pack: string, invita: string;
let n = 0;
const key = () => `mc-${r}-${(n += 1)}`;
const body = (o: Record<string, unknown>) => ({ currency: 'EUR', terminalExternalId: `MC-${r}`, ...o }) as never;
const qrOf = (userId: string) => `https://operator.local/?invita=${signStaffToken({ userId, tenantId: A }, Date.now(), process.env.JWT_SECRET!).token}`;

async function authorize(paymentId: string, order: string): Promise<void> {
  await sys((tx) => tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } }));
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

let live: MoneyMap;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (
      await tx.venue.create({
        data: {
          name: 'Sala Medianoche',
          slug: `mc-${r}`,
          walletGroup: `gmc-${r}`,
          payoutHoldDays: 0,
          platformCommissionBps: 1000,
          // Invitaciones: 40 % para la chica y 3 € por copa para el camarero.
          invitationRules: { chica: { kind: 'PERCENT', bps: 4000 }, camarero: { kind: 'FIXED', cents: 300 } },
        },
      })
    ).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-mc-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    manager = (await tx.user.create({ data: { tenantId: A, email: `man-mc-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
    lola = (
      await tx.user.create({
        data: { tenantId: A, email: `lola-mc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' },
      })
    ).id;
    dani = (
      await tx.user.create({
        data: { tenantId: A, email: `dani-mc-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani', payoutMethod: 'MANUAL_CASH' },
      })
    ).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `MC-${r}`, label: 'Barra' } })).id;
    // La noche, abierta hace 2 h con 100 € de fondo.
    nightId = (await tx.venueNight.create({ data: { tenantId: A, openedAt: ago(2 * HOUR), openingFloatCents: 10_000, openedBy: owner } })).id;
    // Un saldo: 100 € en efectivo y 50 € con tarjeta.
    W = (
      await tx.clientWallet.create({
        data: { tenantId: A, qrToken: `mc-tok-${r}-abcdefgh`, balanceCents: 15_000, status: 'ACTIVE', shortCode: `C${r.slice(0, 5)}`.toUpperCase(), walletGroup: `gmc-${r}` },
      })
    ).id;
    await tx.walletCashTopUp.create({ data: { tenantId: A, walletId: W, amountCents: 10_000, takenByUserId: owner, idempotencyKey: key(), createdAt: ago(90 * 60_000) } });
    await tx.payment.create({
      data: {
        tenantId: A, terminalId: term, idempotencyKey: key(), amountCents: 5_000, availableAmountCents: 5_000, qrToken: `mc-q-${r}-1`,
        qrExpiresAt: ago(-HOUR), status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `MCT${r}`, walletId: W, captureMethod: 'WALLET_TOPUP',
        revenueCategory: 'EXTRA', createdAt: ago(80 * 60_000), authorizedAt: ago(80 * 60_000),
      },
    });
    // Un cobro del datáfono de antes de las líneas (Copas), con 5 € de propina.
    await tx.payment.create({
      data: {
        tenantId: A, terminalId: term, idempotencyKey: key(), amountCents: 3_000, tipCents: 500, availableAmountCents: 3_500, qrToken: `mc-q-${r}-2`,
        qrExpiresAt: ago(-HOUR), status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: `MCP${r}`, captureMethod: 'POS_EXTERNAL',
        posOperationNumber: `op-${r}`, revenueCategory: 'VENUE_BAR', createdByUserId: dani, createdAt: ago(70 * 60_000), authorizedAt: ago(70 * 60_000),
      },
    });
  });
  copa = (await inVenue(A, () => carta.create(A, owner, { name: 'Copa', priceCents: 1_000, category: 'VENUE_BAR' }))).id;
  pack = (
    await inVenue(A, () =>
      carta.create(A, owner, {
        name: '1 h con habitación',
        priceCents: 15_000,
        durationMin: 60,
        category: 'CHICA_SERVICE',
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12_000 },
          { category: 'VENUE_ROOM', amountCents: 3_000 },
        ],
      }),
    )
  ).id;
  invita = (
    await inVenue(A, () => carta.create(A, owner, { name: 'Invitar a una copa', priceCents: 2_500, category: 'VENUE_BAR', isInvitation: true }))
  ).id;

  // Con tarjeta: el pack de Lola (150 €), 2 copas de Dani (20 €) y Dani invita a Lola a 2 copas (50 €).
  const p1 = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: pack }), { userId: lola, role: 'OPERATOR' }));
  await authorize(p1.id, `MC${r}1`);
  const p2 = await inVenue(A, () => payments.create(A, key(), body({ lines: [{ serviceItemId: copa, qty: 2 }] }), { userId: dani, role: 'WAITER' }));
  await authorize(p2.id, `MC${r}2`);
  const p3 = await inVenue(A, () =>
    payments.create(A, key(), body({ lines: [{ serviceItemId: invita, qty: 2 }], invitedStaffToken: qrOf(lola) }), { userId: dani, role: 'WAITER' }),
  );
  await authorize(p3.id, `MC${r}3`);
  // Del saldo: 3 copas que cobra Dani.
  const qr = await inVenue(A, () => charges.createQrCharge({ userId: dani, role: 'WAITER', tenantId: A }, { lines: [{ serviceItemId: copa, qty: 3 }] }));
  await inVenue(undefined, () => charges.payQrCharge(qr.payToken, W));
  await sys(async (tx) => {
    // Se devuelven 10 € de las copas con tarjeta, y 20 € del saldo en efectivo.
    await tx.refund.create({ data: { tenantId: A, paymentId: p2.id, amountCents: 1_000, requestedBy: owner, status: 'SUCCEEDED' } });
    await tx.walletPayout.create({ data: { tenantId: A, walletId: W, amountCents: 2_000, method: 'CASH', paidByUserId: owner } });
    await tx.clientWallet.update({ where: { id: W }, data: { balanceCents: { decrement: 2_000 } } });
  });
  // El camarero cobra su parte de la invitación en efectivo (como una chica).
  await inVenue(A, () => operators.createPayout(A, dani, owner, 'su parte de las invitaciones', { externalRail: 'MANUAL_CASH' }));
  live = await inVenue(A, () => moneyMap.forQuery(A, {}, soon()));
});

afterAll(async () => {
  await prisma.$disconnect();
});

it('historial del camarero: solo sus cobros con tarjeta y saldo, incluida la chica invitada', async () => {
  const controller = new OwnCobrosController(new CobrosService(prisma), moneyMap);
  const page = await inVenue(A, () => controller.list({ sub: dani, tenantId: A, role: 'WAITER' } as JwtPayload, { limit: 50 }));
  expect(page.items).toHaveLength(4);
  expect(page.items.filter((p) => p.kind === 'PAYMENT')).toHaveLength(3);
  expect(page.items.filter((p) => p.kind === 'SALDO')).toHaveLength(1);
  expect(page.items.find((p) => p.invitedName === 'Lola')?.amountCents).toBe(5000);
  // La noche de «Esta noche» en la app, solo con la primera página; nada devuelto aún.
  expect(page.night).toEqual({ from: expect.any(String), open: expect.any(Boolean) });
  expect(page.items.every((p) => p.refundedCents === 0)).toBe(true);
  for (const row of page.items) {
    expect(row).not.toHaveProperty('payment');
    expect(row).not.toHaveProperty('wallet');
  }
  const other = await inVenue(A, () => controller.list({ sub: owner, tenantId: A, role: 'OWNER' } as JwtPayload, { limit: 50 }));
  expect(other.items.some((p) => page.items.some((mine) => mine.id === p.id && mine.kind === p.kind))).toBe(false);
});

describe('el mapa del dinero de la noche, en directo: los carriles cuadran', () => {
  it('cómo entra: tarjeta (y datáfono), del saldo; las recargas aparte', () => {
    expect(live.scope).toEqual({ kind: 'night', nightId, open: true });
    expect(live.inflow).toMatchObject({ cardCents: 22_000, posCents: 3_500, mobileWalletCents: 0, cashCents: 0, saldoCents: 3_000 });
    expect(live.inflow.topUps).toEqual({ totalCents: 15_000, cardCents: 5_000, cashCents: 10_000, count: 2 });
    expect(live.salesCents).toBe(28_500);
    expect(live.salesCount).toBe(5);
    expect(live.inflow.cardRailCents + live.inflow.cashCents + live.inflow.saldoCents).toBe(live.salesCents);
  });

  it('por sección (por línea; los de antes, por su sección; las propinas aparte) = lo vendido', () => {
    const bySection = Object.fromEntries(live.sections.map((s) => [s.code, s.amountCents]));
    expect(bySection).toEqual({
      CHICA_SERVICE: 12_000,
      VENUE_BAR: 2_000 + 5_000 + 3_000 + 3_000,
      VENUE_ROOM: 3_000,
      VENUE_FOOD: 0,
      VENUE_ENTRY: 0,
      [MONEY_MAP_TIPS]: 500,
    });
    expect(live.sections.reduce((a, s) => a + s.amountCents, 0)).toBe(live.salesCents);
  });

  it('cómo se reparte: chicas (comisión e invitación), camarero (invitación), OxioPay y el local = lo vendido', () => {
    // Lola: 90 % de 120 € del pack + 40 % de 50 € de invitación. Dani: 3 € × 2 copas.
    expect(live.split).toMatchObject({ chicasCents: 10_800 + 2_000, camarerosCents: 600 });
    // OxioPay: 10 % de lo vendido sin propinas.
    expect(live.split.commissions).toEqual({ platformCents: 2_800, bankCents: null, totalCents: 2_800 });
    const s = live.split;
    expect(s.venueCents + s.chicasCents + s.camarerosCents + s.commissions.totalCents).toBe(live.salesCents);
    expect(s.venueCents).toBe(12_300);
  });

  it('dónde está: BBVA + caja (como el arqueo) = tuyo + del personal + saldo vivo; el saldo vivo cuadra con las cuentas', async () => {
    expect(live.where.bbvaCents).toBe(25_500 + 5_000 - 1_000);
    // Fondo 100 + recarga 100 − devuelto 20 − pagado al camarero 6.
    expect(live.where.cashBoxCents).toBe(17_400);
    const check = await inVenue(A, () => nights.closeCheck(A));
    expect(live.where.cashBoxCents).toBe(check.cash.expectedCents);
    const o = live.where.owners;
    // Los 6 € al camarero fueron en efectivo: ya salieron de la caja, no se restan otra vez. Los 28 € de OxioPay no son del local.
    expect(o).toEqual({ staffCents: 12_800, saldoCents: 10_000, paidOutCents: 0, commissionsCents: 2_800, venueCents: 46_900 - 12_800 - 10_000 - 2_800 });
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.commissionsCents ?? 0)).toBe(live.where.totalCents);
    // Recargas − consumos − devuelto = lo que tienen los saldos de verdad.
    expect(live.where.liveSaldoCents).toBe(10_000);
    const wallet = await sys((tx) => tx.clientWallet.findUnique({ where: { id: W } }));
    expect(wallet!.balanceCents).toBe(o.saldoCents);
    expect(live.where.owed).toEqual({ chicasCents: 12_800, camarerosCents: 0, bankHeldCents: 0, debtCents: 0 });
  });

  it('qué sale: lo pagado al camarero, lo pendiente de Lola, devoluciones y comisiones', () => {
    expect(live.outflow.payouts).toEqual([{ who: 'camareros', rail: 'MANUAL_CASH', count: 1, cents: 600 }]);
    expect(live.outflow.pendingStaff).toEqual({ chicasCents: 12_800, camarerosCents: 0 });
    // De los 10 € devueltos a tarjeta, los 10 eran venta (las copas): es lo que resta «¿Cuánto he ganado?».
    expect(live.outflow.refunds).toEqual({ cardCents: 1_000, cardCount: 1, cashCents: 2_000, cashCount: 1, salesCents: 1_000 });
    expect(venueEarnedCents(live)).toBe(12_300 - 1_000);
    expect(live.outflow.commissionsCents).toBe(2_800);
  });
});

describe('el Z y el Z del periodo, por línea, cuadran con el mapa', () => {
  it('el Z en vivo: por tipo de cobro, cada sección con lo suyo (y lo mismo que el mapa)', async () => {
    const view = await inVenue(A, () => nights.current(A));
    const s = view!.z.summary;
    expect(s.byType).toEqual([
      { label: 'Servicios', count: 1, chargedCents: 12_000 },
      { label: 'Copas', count: 3, chargedCents: 10_500 },
      { label: 'Habitaciones', count: 1, chargedCents: 3_000 },
      { label: 'Recarga con tarjeta', count: 1, chargedCents: 5_000 },
      { label: 'Recarga en efectivo', count: 1, chargedCents: 10_000 },
    ]);
    expect(s.saldoByType).toEqual([{ label: 'Copas', count: 1, chargedCents: 3_000 }]);
    const sales = s.byType.filter((t) => !t.label.startsWith('Recarga')).reduce((a, t) => a + t.chargedCents, 0);
    expect(sales).toBe(live.inflow.cardRailCents);
    expect(s.consumptionsCents).toBe(live.inflow.saldoCents);
  });

  it('con las secciones renombradas en Ajustes → Secciones, el Z dice sus nombres (mismos importes)', async () => {
    await sys((tx) =>
      tx.venue.update({
        where: { id: A },
        data: { sections: { CHICA_SERVICE: { label: 'Reservados VIP' }, VENUE_BAR: { label: 'Barra de arriba' } } },
      }),
    );
    try {
      const s = (await inVenue(A, () => nights.current(A)))!.z.summary;
      expect(s.byType).toEqual([
        { label: 'Reservados VIP', count: 1, chargedCents: 12_000 },
        { label: 'Barra de arriba', count: 3, chargedCents: 10_500 },
        { label: 'Habitaciones', count: 1, chargedCents: 3_000 },
        { label: 'Recarga con tarjeta', count: 1, chargedCents: 5_000 },
        { label: 'Recarga en efectivo', count: 1, chargedCents: 10_000 },
      ]);
      expect(s.saldoByType).toEqual([{ label: 'Barra de arriba', count: 1, chargedCents: 3_000 }]);
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: A }, data: { sections: Prisma.DbNull } }));
    }
  });

  it('lo cobrado, por partes («Hoy · cobrado» y el Z): ventas con tarjeta + propinas + recargas; y los pagos con tarjeta', async () => {
    // 5 pagos con tarjeta: la recarga de 50 €, el datáfono (30 € + 5 de propina), el pack (150), 2 copas (20)
    // y la invitación (2 × 25). Más la recarga de 100 € en efectivo. A mano: 300 + 5 + 100 = 405 € cobrados =
    // 250 de ventas + 5 de propinas + 150 de recargas (50 con tarjeta + 100 en efectivo).
    const s = (await inVenue(A, () => nights.current(A)))!.z.summary;
    expect(s).toMatchObject({
      count: 5,
      grossCents: 30_000,
      tipsCents: 500,
      walletCardTopUpsCount: 1,
      walletCardTopUpsCents: 5_000,
      walletCashTopUpsCount: 1,
      walletCashTopUpsCents: 10_000,
      chargedCents: 40_500,
    });
    const t = await inVenue(A, () => period.totals(A, { from: ago(3 * HOUR), to: soon() }));
    expect(chargedParts(t)).toEqual({ salesCents: 25_000, tipCents: 500, topUpCents: 15_000 });
    expect(chargedCents(t)).toBe(40_500);
    expect(metricsPeriod(t)).toMatchObject({ count: 5, grossCents: 30_000, walletCardTopUpCents: 5_000, walletCashTopUpCents: 10_000 });
    // Las ventas con tarjeta del mapa son esas mismas 250 € + 5 de propina.
    expect(live.inflow.cardRailCents).toBe(25_500);
  });

  it('el Z del periodo: por sección y por línea, con las del saldo', async () => {
    const z = await inVenue(A, () => period.periodZ(A, { from: ago(3 * HOUR), to: new Date() }));
    const by = Object.fromEntries(z.byRevenueCategory.map((c) => [c.category, [c.grossCents, c.tipCents, c.count]]));
    expect(by).toEqual({
      CHICA_SERVICE: [12_000, 0, 1],
      VENUE_BAR: [13_000, 500, 4],
      VENUE_ROOM: [3_000, 0, 1],
    });
    expect(z.wallet).toMatchObject({ topUpCents: 15_000, consumptionCents: 3_000 });
  });
});

describe('las fichas de la noche cuadran con el mapa', () => {
  it('la de Lola: su pack y su invitación (que cobró Dani), con su parte', async () => {
    const f = await inVenue(A, () => staffFichas.ficha(A, lola, soon()));
    expect(f.person).toEqual({ id: lola, name: 'Lola', role: 'OPERATOR' });
    expect(f.window).toMatchObject({ nightId, open: true });
    expect(f.rows.map((r) => [r.title, r.section, r.amountCents, r.shareCents, r.chargedBy?.name ?? null, r.via])).toEqual([
      ['Invitación', 'VENUE_BAR', 5_000, 2_000, 'Dani', 'QR'],
      ['1 h con habitación', 'CHICA_SERVICE', 15_000, 10_800, null, 'QR'],
    ]);
    expect(f.rows[1]!.sections).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 12_000 },
      { category: 'VENUE_ROOM', amountCents: 3_000 },
    ]);
    // Lo suyo de la noche = lo de las chicas en el mapa.
    expect(f.stats).toEqual({ soldCents: 20_000, shareCents: live.split.chicasCents, paidCents: 0, count: 2 });
    expect(f.rates).toEqual([
      { kind: 'section', code: 'CHICA_SERVICE', bps: 9000 },
      { kind: 'invitation', share: { kind: 'PERCENT', bps: 4000 } },
      { kind: 'tips', bps: 10_000 },
    ]);
  });

  it('la de Dani (camarero): su parte de la invitación, ya pagada', async () => {
    const f = await inVenue(A, () => staffFichas.ficha(A, dani, soon()));
    expect(f.person.role).toBe('WAITER');
    expect(f.rows).toEqual([expect.objectContaining({ title: 'Invitación', amountCents: 5_000, shareCents: 600, chargedBy: null })]);
    expect(f.stats).toMatchObject({ shareCents: live.split.camarerosCents, paidCents: 600 });
    expect(f.rates).toEqual([{ kind: 'invitation', share: { kind: 'FIXED', cents: 300 } }]);
    expect(f.payouts).toEqual([expect.objectContaining({ cents: 600, rail: 'MANUAL_CASH' })]);
  });

  it('la del saldo: recargado − gastado − devuelto = lo que le queda; el consumo, por NFC/QR y con su sección', async () => {
    const f = await inVenue(A, () => walletFichas.ficha(A, W));
    const recargado = f.topUps.reduce((a, t) => a + t.amountCents, 0);
    const gastado = f.consumptions.filter((c) => c.status !== 'REVERSED').reduce((a, c) => a + c.amountCents + c.tipCents, 0);
    const devuelto = f.refunds.filter((x) => x.status === 'DONE').reduce((a, x) => a + x.amountCents, 0);
    expect([recargado, gastado, devuelto]).toEqual([15_000, 3_000, 2_000]);
    expect(recargado - gastado - devuelto).toBe(f.wallet.balanceCents);
    expect(f.consumptions[0]).toMatchObject({ via: 'Face ID', sections: [{ category: 'VENUE_BAR', amountCents: 3_000 }] });
    expect(f.cards).toEqual([]);
  });
});

describe('al cerrar la noche, el mapa se congela en el Z', () => {
  it('cierra con la caja contada y el Z lleva el mapa: el mismo que en directo', async () => {
    const check = await inVenue(A, () => nights.closeCheck(A));
    const acknowledged = check.steps.filter((s) => s.status !== 'ok').map((s) => s.key);
    const closed = await inVenue(A, () =>
      nights.close(A, { userId: owner, role: 'OWNER' }, nightId, { cashCountedCents: check.cash.expectedCents, acknowledged, note: 'prueba' }),
    );
    const night = await sys((tx) => tx.venueNight.findUnique({ where: { id: nightId } }));
    const z = night!.zReport as unknown as NightZ;
    expect(z.moneyMap).toBeDefined();
    // La noche que devuelve el cierre no lo trae: solo /admin/money-map, que pide «Informes».
    expect(closed.z).not.toHaveProperty('moneyMap');
    const frozen = await inVenue(A, () => moneyMap.forQuery(A, { night: nightId }));
    expect(frozen.frozen).toBe(true);
    expect(frozen.scope).toEqual({ kind: 'night', nightId, open: false });
    const strip = (m: MoneyMap) => ({ ...m, scope: null, frozen: null, generatedAt: null, to: null });
    expect(strip(frozen)).toEqual(strip(live));
    expect(frozen.where.cashBoxCents).toBe(z.caja!.expectedCents);
    expect(frozen.to).toBe(z.to);
  });

  it('lo que se apunte después no cambia el congelado', async () => {
    await sys((tx) => tx.walletCashTopUp.create({ data: { tenantId: A, walletId: W, amountCents: 999, takenByUserId: owner, idempotencyKey: key() } }));
    const frozen = await inVenue(A, () => moneyMap.forQuery(A, { night: nightId }));
    expect(frozen.inflow.topUps.cashCents).toBe(10_000);
    const now = await inVenue(A, () => moneyMap.forQuery(A, { night: 'current' }, soon()));
    expect(now.scope).toEqual({ kind: 'night', nightId: null, open: false });
    expect(now.inflow.topUps.cashCents).toBe(999);
  });
});

describe('la parte del camarero: se ve y se paga como la de una chica', () => {
  it('sale en la lista de camareros con su saldo; ya pagado, a cero; su pago, en su historial', async () => {
    const list = await inVenue(A, () => operators.listVenueOperators(A, 'WAITER'));
    expect(list.map((o) => [o.id, o.balance.pendingCents, o.balance.paidCents])).toEqual([[dani, 0, 600]]);
    const paid = await inVenue(A, () => operators.listOperatorPayouts(A, dani));
    expect(paid).toEqual([expect.objectContaining({ totalCents: 600, externalRail: 'MANUAL_CASH', earningCount: 1 })]);
  });

  it('con otra invitación, el encargado le pide el pago al dueño («Por aprobar», como a una chica)', async () => {
    const p = await inVenue(A, () =>
      payments.create(A, key(), body({ lines: [{ serviceItemId: invita, qty: 1 }], invitedStaffToken: qrOf(lola) }), { userId: dani, role: 'WAITER' }),
    );
    await authorize(p.id, `MC${r}4`);
    const asked = await inVenue(A, () =>
      requests.requestPayout({ userId: manager, role: 'MANAGER', tenantId: A }, dani, { externalRail: 'MANUAL_CASH' }),
    );
    expect(asked).toMatchObject({ status: 'PENDING', amountCents: 300 });
  });
});

describe('lo que se debe a las compañeras: por persona, sin compensar (como Pagos a compañeras)', () => {
  it('la deuda de una (devolución tras pagarle) no resta de lo que se debe a las demás: sale aparte, y una recarga devuelta no es venta', async () => {
    const before = await inVenue(A, () => moneyMap.forQuery(A, {}, soon()));
    // Bea hace un pack (120 € de servicio, su 50 %: 60 €) y se le paga en efectivo.
    const bea = (
      await sys((tx) =>
        tx.user.create({
          data: { tenantId: A, email: `bea-mc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 5000, displayName: 'Bea', payoutMethod: 'MANUAL_CASH' },
        }),
      )
    ).id;
    const p = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: pack }), { userId: bea, role: 'OPERATOR' }));
    await authorize(p.id, `MC${r}5`);
    await inVenue(A, () => operators.createPayout(A, bea, owner, 'lo de esta noche', { externalRail: 'MANUAL_CASH' }));
    const earning = await sys((tx) => tx.operatorEarning.findFirstOrThrow({ where: { operatorId: bea, paymentId: p.id } }));
    expect(earning.payoutId).not.toBeNull();
    const hers = earning.commissionCents + earning.tipCents;
    expect(hers).toBe(6_000);
    const paid = await inVenue(A, () => moneyMap.forQuery(A, {}, soon()));
    // Ya cobrada: a Bea no se le debe nada y lo de las demás no cambia.
    expect(paid.where.owed).toMatchObject({ chicasCents: before.where.owed!.chicasCents, debtCents: 0 });
    const topUp = await sys((tx) => tx.payment.findFirstOrThrow({ where: { tenantId: A, walletId: W, captureMethod: 'WALLET_TOPUP' } }));
    await sys(async (tx) => {
      // Después se devuelve entero el cobro de Bea: su parte ya pagada pasa a ser deuda suya.
      const refund = await tx.refund.create({ data: { tenantId: A, paymentId: p.id, amountCents: 15_000, requestedBy: owner, status: 'SUCCEEDED' } });
      await tx.earningReversal.create({ data: { tenantId: A, earningId: earning.id, refundId: refund.id, reversedDeltaCents: hers, afterPayout: true } });
      // Y 20 € de la recarga con tarjeta: una devolución que no es de ventas.
      await tx.refund.create({ data: { tenantId: A, paymentId: topUp.id, amountCents: 2_000, requestedBy: owner, status: 'SUCCEEDED' } });
    });
    const after = await inVenue(A, () => moneyMap.forQuery(A, {}, soon()));
    // Lo que se debe a las demás sigue igual (antes, la deuda de Bea se lo restaba) y lo de Bea va aparte.
    expect(after.where.owed).toMatchObject({ chicasCents: before.where.owed!.chicasCents, debtCents: hers });
    // De lo devuelto a tarjeta en la ventana, solo cuenta como venta lo del cobro de Bea, no lo de la recarga.
    expect(after.outflow.refunds.cardCents - paid.outflow.refunds.cardCents).toBe(15_000 + 2_000);
    expect((after.outflow.refunds.salesCents ?? 0) - (paid.outflow.refunds.salesCents ?? 0)).toBe(15_000);
  });
});
