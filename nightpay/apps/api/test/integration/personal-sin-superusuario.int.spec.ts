// Integración (Postgres real): el API con un rol de base de datos SIN superusuario, dueño de las tablas
// (FORCE RLS). Cada prueba entra como el personal: el local en el contexto (lo pone AuthGuard) y NADA de
// asSystem en la prueba. Dos locales con los mismos datos: si algo se colara del otro, los números no cuadran.
// Ver README.md y docs/DB-ROLE.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { TreasuryService } from '../../src/modules/treasury/treasury.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { PeanpeAdapter } from '../../src/modules/gateways/peanpe.adapter';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const settings: Record<string, string | number> = {
  OPERATOR_BASE_URL: 'https://chicas.example.com',
  GATEWAY_TIMEOUT_MS: 5000,
  PEANPE_API_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  PEANPE_ACCOUNT_ID: '91816',
  PEANPE_API_BASE_URL: 'http://peanpe.invalid',
  PEANPE_AMOUNT_FORMAT_VERIFIED: 'cents',
};
const config = {
  get: (k: string) => settings[k],
  getOrThrow: (k: string) => {
    if (settings[k] === undefined) throw new Error(`sin ${k}`);
    return settings[k];
  },
};
// Explorador on-chain y tipo de cambio de mentira: el hash «cuadra».
const verifier = { verify: async () => ({ matched: true, status: 'MATCHED', occurredAt: new Date(), actualAmountCents: null }) };
const fx = { getEurToUsdtRateInfo: async () => ({ rate: 1.07, degraded: false }), forMethod: () => verifier };
const gatewayMetrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };

const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, fx as never, {} as never);
const treasury = new TreasuryService(prisma, audit as never, fx as never, config as never);
const wallets = new WalletsService(prisma, audit as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never);
const peanpe = new PeanpeAdapter(config as never, gatewayMetrics as never, prisma);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  peanpe,
  {} as never,
);
const refunds = new RefundsService(
  prisma,
  cls as never,
  {} as never,
  payments,
  {} as never,
  audit as never,
  { refundsCreated: { inc: vi.fn() }, earningReversalFailed: { inc: vi.fn() } } as never,
);
const reports = new ReportsService(prisma);
const period = new PeriodReportsService(prisma);
const incidents = new IncidentsService(prisma, audit as never);
const nights = new NightsService(prisma, reports, audit as never, new CloseCheckService(prisma, incidents, config as never));

/** Una petición del panel o de la app de la chica de ese local (como tras AuthGuard). */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
/** Sin local: la página del cliente o un aviso del banco. */
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-public' });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Venue {
  id: string;
  owner: string;
  chica: string;
  term: string;
  oldPayment: string;
  wallet: string;
  code: string;
}

/** Un local con: cobro viejo (ya se puede pagar a la chica), cobro y consumo de la última noche, saldo con «Me voy». */
async function seedVenue(tag: 'A' | 'B'): Promise<Venue> {
  return asPublic(() =>
    prisma.asSystem(async (tx) => {
      const id = (await tx.venue.create({ data: { name: `Local ${tag}`, slug: `ns-${tag}-${r}`, walletGroup: `gns-${tag}-${r}` } })).id;
      const owner = (await tx.user.create({ data: { tenantId: id, email: `own-${tag}-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const chica = (
        await tx.user.create({
          data: {
            tenantId: id, email: `chica-${tag}-${r}@x.es`, displayName: `Chica ${tag}`, passwordHash: 'x', role: 'OPERATOR',
            payoutMethod: 'USDT_TRC20', payoutAddress: `TQ${tag}${r}xxxxxxxxxxxxxxxxxxxxxxxxx`,
          } as never,
        })
      ).id;
      const term = (await tx.terminal.create({ data: { tenantId: id, externalId: `TNS-${tag}-${r}`, label: tag } })).id;
      const pay = (n: string, o: Record<string, unknown>) =>
        tx.payment.create({
          data: {
            tenantId: id, terminalId: term, idempotencyKey: `ns-${tag}-${n}-${r}`, qrToken: `ns-${tag}-${n}-${r}`,
            qrExpiresAt: ago(-HOUR), status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `NS${tag}${n}${r}`,
            createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', ...o,
          } as never,
        });
      // Hace 30 días: 100 €, comisión 90 € (ya pasó la espera de PAYOUT_HOLD_DAYS).
      const old = await pay('old', { amountCents: 10_000, availableAmountCents: 10_000, authorizedAt: ago(30 * DAY), createdAt: ago(30 * DAY) });
      await tx.operatorEarning.create({
        data: { tenantId: id, operatorId: chica, paymentId: old.id, paymentAmountCents: 10_000, commissionBps: 9000, commissionCents: 9000, createdAt: ago(30 * DAY) },
      });
      // La última noche (cerrada hace 1 h): cobro de 50 € + 5 € de propina y un consumo del saldo de 20 €.
      await tx.venueNight.create({ data: { tenantId: id, openedAt: ago(3 * HOUR), closedAt: ago(HOUR), openedBy: owner, closedBy: owner } });
      const night = await pay('night', { amountCents: 5000, tipCents: 500, availableAmountCents: 5000, authorizedAt: ago(2 * HOUR), createdAt: ago(2 * HOUR) });
      await tx.operatorEarning.create({
        data: { tenantId: id, operatorId: chica, paymentId: night.id, paymentAmountCents: 5000, commissionBps: 9000, commissionCents: 4500, tipCents: 500, createdAt: ago(2 * HOUR) },
      });
      const code = `${tag}${r}`.toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
      const wallet = (
        await tx.clientWallet.create({
          data: { tenantId: id, balanceCents: 3000, qrToken: `nsw-${tag}-${r}`, shortCode: code, walletGroup: `gns-${tag}-${r}`, closeRequestedAt: ago(5 * MIN) },
        })
      ).id;
      const c = await tx.walletConsumption.create({
        data: { tenantId: id, walletId: wallet, amountCents: 2000, providedByUserId: chica, category: 'CHICA_SERVICE', createdAt: ago(2 * HOUR) },
      });
      await tx.operatorEarning.create({
        data: { tenantId: id, operatorId: chica, consumptionId: c.id, paymentAmountCents: 2000, commissionBps: 5000, commissionCents: 1000, createdAt: ago(2 * HOUR) },
      });
      return { id, owner, chica, term, oldPayment: old.id, wallet, code };
    }),
  );
}

let A: Venue, B: Venue;
let payoutA: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  A = await seedVenue('A');
  B = await seedVenue('B');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el personal con un rol sin superusuario (FORCE RLS, sin asSystem en la prueba)', () => {
  it('panel: chicas con su saldo, sus comisiones y sus pagos, solo las del local', async () => {
    const list = await asStaff(A.id, () => operators.listVenueOperators(A.id));
    expect(list.map((o) => o.id)).toEqual([A.chica]);
    // 90 + (45 + 5) + 10; disponible solo lo de hace 30 días.
    expect(list[0]!.balance).toMatchObject({ pendingCents: 15_000, availableCents: 9000, heldCents: 6000, debtCents: 0, count: 3 });

    const earnings = await asStaff(A.id, () => operators.listOperatorEarnings(A.id, A.chica));
    expect(earnings).toHaveLength(3);
    expect(earnings.map((e) => e.netCents).sort((a, b) => a - b)).toEqual([1000, 5000, 9000]);
    expect(await asStaff(A.id, () => operators.listOperatorPayouts(A.id, A.chica))).toEqual([]);
    // La chica del otro local no existe para este panel.
    await expect(asStaff(A.id, () => operators.listOperatorEarnings(A.id, B.chica))).rejects.toThrow(/no encontrada/i);
  });

  it('pago a la chica: se crea con lo que ya pasó la espera, se verifica con el hash y no toca el otro local', async () => {
    const created = await asStaff(A.id, () =>
      operators.createPayout(A.id, A.chica, A.owner, 'semana', { externalTxId: `hash-a-${r}`, externalRail: 'USDT_TRC20' }),
    );
    expect(created).toMatchObject({ totalCents: 9000, earningCount: 1 });
    payoutA = created.id;
    // El mismo hash en el otro local es otro pago (único por local).
    const createdB = await asStaff(B.id, () =>
      operators.createPayout(B.id, B.chica, B.owner, undefined, { externalTxId: `hash-a-${r}`, externalRail: 'USDT_TRC20' }),
    );
    expect(createdB).toMatchObject({ totalCents: 9000, earningCount: 1 });

    // La app de la chica: su pago, su saldo.
    const mine = await asStaff(A.id, () => operators.getMyPayouts(A.chica, A.id));
    expect(mine).toEqual([expect.objectContaining({ id: payoutA, totalCents: 9000, earningCount: 1, reconciliationStatus: 'UNRECONCILED' })]);
    const balance = await asStaff(A.id, () => operators.getBalance(A.chica, A.id));
    expect(balance).toMatchObject({ paidCents: 9000, availableCents: 0, pendingCents: 6000 });

    const verified = await asStaff(A.id, () =>
      treasury.verifyPayout(A.id, payoutA, A.owner, { externalTxId: `hash-a-${r}`, externalRail: 'USDT_TRC20' }),
    );
    expect(verified).toMatchObject({ matched: true, status: 'MATCHED' });
    // Repetirlo: ya conciliado, no se vuelve a mirar.
    const again = await asStaff(A.id, () =>
      treasury.verifyPayout(A.id, payoutA, A.owner, { externalTxId: `hash-a-${r}`, externalRail: 'USDT_TRC20' }),
    );
    expect(again.reason).toBe('already_reconciled');
    // El pago de otro local no se verifica desde aquí.
    await expect(
      asStaff(A.id, () => treasury.verifyPayout(A.id, createdB.id, A.owner, { externalTxId: `hash-a-${r}`, externalRail: 'USDT_TRC20' })),
    ).rejects.toThrow();
  });

  it('devolución del banco de un cobro ya pagado a la chica: queda como deuda en su saldo y en tesorería', async () => {
    const res = await asStaff(A.id, () =>
      refunds.registerBankRefund(
        { paymentId: A.oldPayment, amountCents: 5000, reason: 'cliente' },
        { userId: A.owner, role: 'OWNER', tenantId: A.id },
      ),
    );
    expect(res.status).toBe('SUCCEEDED');
    const balance = await asStaff(A.id, () => operators.getBalance(A.chica, A.id));
    expect(balance.debtCents).toBe(4500);
    const stats = await asStaff(A.id, () => treasury.getStats(A.id));
    expect(stats.operatorDebtCents).toBe(4500);
    // El otro local no tiene deuda.
    expect((await asStaff(B.id, () => operators.getBalance(B.chica, B.id))).debtCents).toBe(0);
  });

  it('tesorería: estadísticas solo del local', async () => {
    const stats = await asStaff(A.id, () => treasury.getStats(A.id));
    expect(stats).toMatchObject({
      payoutsThisMonthCount: 1,
      payoutsThisMonthCents: 9000,
      heldPayoutsCents: 6000,
      byMethod: { USDT_TRC20: 1 },
      byReconciliationStatus: { MATCHED: 1 },
    });
    const statsB = await asStaff(B.id, () => treasury.getStats(B.id));
    expect(statsB).toMatchObject({ payoutsThisMonthCount: 1, operatorDebtCents: 0, byReconciliationStatus: { UNRECONCILED: 1 } });
  });

  it('saldos del panel: lista, ficha, estadísticas y buscar por código', async () => {
    const list = await asStaff(A.id, () => wallets.listForAdmin({ tenantId: A.id }));
    expect(list.map((w) => w.id)).toEqual([A.wallet]);
    expect(list[0]).toMatchObject({ balanceCents: 3000, consumptionCount: 1 });

    const view = await asStaff(A.id, () => wallets.getWalletView({ tenantId: A.id, walletId: A.wallet }));
    expect(view.consumptions).toEqual([expect.objectContaining({ amountCents: 2000, providedByName: 'Chica A' })]);
    await expect(asStaff(A.id, () => wallets.getWalletView({ tenantId: A.id, walletId: B.wallet }))).rejects.toThrow('Saldo no encontrado');

    const stats = await asStaff(A.id, () => wallets.getAdminStats(A.id, { from: new Date(0), open: false }));
    expect(stats).toMatchObject({ activeCount: 1, totalBalanceCents: 3000 });

    const found = await asStaff(A.id, () => charges.lookup(A.id, A.code));
    expect(found).toMatchObject({ walletId: A.wallet, balanceCents: 3000, isHomeVenue: true, closeRequested: true });
    // El saldo de otro grupo de locales no vale aquí.
    await expect(asStaff(A.id, () => charges.lookup(A.id, B.code))).rejects.toThrow();
  });

  it('«Mi noche» de la chica y el Z al cerrar la noche', async () => {
    // Última noche cerrada: el cobro (50 + 5) y el consumo del saldo (20).
    const mine = await asStaff(A.id, () => nights.mine(A.id, A.chica));
    expect(mine).toMatchObject({ count: 2, chargedCents: 5500 + 2000, commissionCents: 4500 + 1000, tipsCents: 500, netCents: 6000 });

    const opened = await asStaff(A.id, () => nights.open(A.id, A.owner));
    // El «Me voy» del saldo sigue sin devolver: se confirma al cerrar (cierre en pasos).
    const closed = await asStaff(A.id, () =>
      nights.close(A.id, { userId: A.owner, role: 'OWNER' }, opened.id, { acknowledged: ['saldo', 'incidencias'] }),
    );
    // Desde el cierre anterior: el pago a la chica de hoy (el del otro local no) y la devolución apuntada.
    expect(closed.z.summary).toMatchObject({ payoutsCount: 1, payoutsCents: 9000 });

    const z = await asStaff(A.id, () => period.periodZ(A.id, { from: ago(40 * DAY), to: new Date(Date.now() + MIN) }));
    expect(z.topOperators).toEqual([expect.objectContaining({ displayName: 'Chica A', earningCount: 3 })]);
    expect(z.payouts).toEqual({ count: 1, totalCents: 9000 });
    expect(z.wallet).toMatchObject({ consumptionCount: 1, consumptionCents: 2000 });
  });

  it('incidencias: el «Me voy» del saldo de este local, no el del otro', async () => {
    const items = await asStaff(A.id, () => incidents.list(A.id, new Date()));
    const walletRefs = items.filter((i) => i.kind === 'wallet_close_requested').map((i) => i.refId);
    expect(walletRefs).toEqual([A.wallet]);
  });

  it('Peanpe: el cobro prepara su llamada y el aviso del banco (sin local) la encuentra', async () => {
    const payment = await asPublic(() =>
      prisma.asSystem((tx) =>
        tx.payment.create({
          data: {
            tenantId: A.id, terminalId: A.term, idempotencyKey: `ns-pe-${r}`, qrToken: `ns-pe-${r}`, qrExpiresAt: ago(-HOUR), amountCents: 2000,
            availableAmountCents: 2000, status: 'AUTHORIZING', provider: 'PEANPE', revenueCategory: 'VENUE_BAR',
          } as never,
        }),
      ),
    );
    // La página del cliente (sin local en el contexto).
    const auth = await asPublic(() =>
      peanpe.authorize({ tenantId: A.id, paymentId: payment.id, amountCents: 2000, currency: 'EUR', terminalExternalId: 'T', reference: 'x' }),
    );
    expect(auth.providerTxId).toMatch(/^[A-Za-z0-9]{6}$/);
    const redirect = await asPublic(() => payments.getPeanpeRedirectUrl(payment.qrToken));
    expect(redirect.url).toContain(auth.providerTxId);

    // El aviso de Peanpe: sin local.
    const token = await asPublic(() => peanpe.getSecurityTokenForCall(auth.providerTxId));
    expect(token).toMatch(/^\d{10}$/);
    const resolved = await asPublic(() => peanpe.resolvePaymentFromCallback({ identificadorLlamada: auth.providerTxId, seguridad: token! }));
    expect(resolved).toEqual({ paymentId: payment.id, tenantId: A.id });
    await asPublic(() => peanpe.persistCallbackResult(auth.providerTxId, '200', 'ok'));
    const call = await asStaff(A.id, () =>
      prisma.$transaction((tx) => tx.peanpeCall.findUnique({ where: { identificadorLlamada: auth.providerTxId } })),
    );
    expect(call).toMatchObject({ resultStatus: '200', resultMsg: 'ok' });
    // Desde el otro local, con su local en la sesión, no existe.
    const fromB = await asStaff(B.id, () =>
      prisma.$transaction((tx) => tx.peanpeCall.findUnique({ where: { identificadorLlamada: auth.providerTxId } })),
    );
    expect(fromB).toBeNull();
  });
});
