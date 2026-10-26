// Integración (Postgres real, np_app, FORCE RLS): la «Comisión del servicio».
// Un local con el interruptor ENCENDIDO (10 % en los pagos con tarjeta y
// datáfono, 12 % en las recargas) y otro APAGADO (todo como hoy), con la
// noche entera: pago directo con propina por Redsys (formulario firmado y
// aviso firmado de verdad) y por el datáfono, recarga con tarjeta y en
// efectivo, gasto del saldo (cobro único pagado con el saldo), «Devolver
// saldo», devolución total y parcial de un pago directo, cierre con arqueo,
// mapa del dinero, Z congelado, CSV de la gestoría y totales del periodo.
// Además: la migración 20261030100000 (CHECK y repetible) y que encender el
// interruptor no cambia los cobros ya creados. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { ConflictException } from '@nestjs/common';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import type { MoneyMap } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { RedsysAdapter } from '../../src/modules/gateways/redsys.adapter';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import type { PosDevice } from '../../src/modules/pos-device/device.guard';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { cobrosCsv, recargasEfectivoCsv, resumenCsv, summarize } from '../../src/modules/reports/export-csv';
import { parseReportPeriod } from '../../src/modules/reports/report-period';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import type { NightZ } from '../../src/modules/nights/night-rules';
import { invitationTotals } from '../../src/modules/money-map/invitation-totals';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => undefined) };
const config = { get: () => undefined, getOrThrow: () => undefined };
const totp = { isEnabled: vi.fn(async () => true), assertForUser: vi.fn(async () => undefined) };
const metrics = {
  paymentsCreated: { inc: noop },
  paymentsTransitioned: { inc: noop },
  walletCreditSkipped: { inc: noop },
  duplicateCharges: { inc: noop },
  refundsCreated: { inc: noop },
  earningReversalFailed: { inc: noop },
};

// Redsys de verdad: firma el formulario (sin red) y comprueba el aviso firmado.
const SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const MERCHANT = '999008881';
const redsys = new RedsysAdapter(
  {
    get: (k: string) =>
      ({
        REDSYS_MERCHANT_CODE: MERCHANT,
        REDSYS_TERMINAL: '1',
        REDSYS_SECRET_KEY: SECRET,
        REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
      })[k],
  } as never,
  { gatewayDuration: { observe: noop }, circuitState: { set: noop } } as never,
);
const registry = { get: () => redsys };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  registry as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const ingest = new WebhookIngestProcessor(prisma as never, payments as never, registry as never);
// El banco (o el portal) devuelve lo que se le pide.
const refundGateway = { get: () => ({ refund: async () => ({ status: 'SUCCEEDED', providerRefundId: `DEV-${randomUUID().slice(0, 8)}` }) }) };
const refunds = new RefundsService(prisma as never, cls as never, refundGateway as never, payments as never, {} as never, audit as never, metrics as never);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => refunds } as never, totp as never);
const cash = new CashTopUpService(prisma as never, audit as never, totp as never);
// Paytef confirma lo que dice el datáfono.
const prover = { prove: async (claim: { amountCents: number }) => ({ kind: 'confirmed' as const, amountCents: claim.amountCents, currency: 'EUR' }) };
const pos = new PosDeviceService(prisma as never, payments as never, audit as never, cls as never, prover as never);
const reports = new ReportsService(prisma);
const period = new PeriodReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, config as never);
const fichas = new StaffFichaService(prisma, moneyMap);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, undefined, moneyMap);
// La noche se abre «hace 2 h»: que el cierre automático de las 08:00 no se cruce con la prueba.
vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);

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
const soon = () => new Date(Date.now() + 1_000);
let n = 0;
const key = () => `fee-${r}-${(n += 1)}-${randomBytes(3).toString('hex')}`;
const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

/** Un local de la prueba: dueño, chica (90 % en Servicios), camarero, datáfono, Redsys y su noche abierta hace 2 h. */
interface Local {
  V: string;
  owner: string;
  lola: string;
  term: string;
  externalId: string;
  servicio: string;
  nightId: string;
}

async function local(name: string, fee: { enabled: boolean; cardBps?: number; topUpBps?: number }): Promise<Local> {
  const slug = `fee-${name}-${r}`;
  return sys(async (tx) => {
    const V = (
      await tx.venue.create({
        data: {
          name: `Sala ${name}`,
          slug,
          walletGroup: `g${slug}`,
          platformCommissionBps: 1000,
          payoutHoldDays: 0,
          serviceFeeEnabled: fee.enabled,
          serviceFeeBps: fee.cardBps ?? 1000,
          topUpServiceFeeBps: fee.topUpBps ?? 1000,
        },
      })
    ).id;
    const externalId = `FEE-${name}-${r}`;
    const term = (await tx.terminal.create({ data: { tenantId: V, externalId, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    const owner = (await tx.user.create({ data: { tenantId: V, email: `own-${slug}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    const lola = (
      await tx.user.create({
        data: { tenantId: V, email: `lola-${slug}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' },
      })
    ).id;
    const servicio = (await tx.serviceItem.create({ data: { tenantId: V, name: 'Servicio', priceCents: 3300, category: 'CHICA_SERVICE' } })).id;
    const nightId = (await tx.venueNight.create({ data: { tenantId: V, openedAt: ago(2 * HOUR), openingFloatCents: 10_000, openedBy: owner } })).id;
    return { V, owner, lola, term, externalId, servicio, nightId };
  });
}

const ownerActor = (l: Local) => ({ userId: l.owner, role: 'OWNER' as const, tenantId: l.V });

/** «Cobrar» de la chica: el servicio de la carta (33 €), con o sin el saldo enlazado o por datáfono. */
const cobro = (l: Local, extra: Record<string, unknown> = {}) =>
  inVenue(l.V, () =>
    payments.create(
      l.V,
      key(),
      { currency: 'EUR', terminalExternalId: l.externalId, lines: [{ serviceItemId: l.servicio, qty: 1 }], ...extra } as never,
      { userId: l.lola, role: 'OPERATOR' },
    ),
  );

/** Recarga con tarjeta (QR de recepción, la crea el dueño). */
const cardTopUp = (l: Local, amountCents: number, wallet: Record<string, unknown> = { create: true }) =>
  inVenue(l.V, () =>
    payments.create(l.V, key(), { currency: 'EUR', terminalExternalId: l.externalId, amountCents, wallet } as never, {
      userId: l.owner,
      role: 'OWNER',
    }),
  );

/** El cliente pulsa «Pagar» en /pay: se abre el pedido en Redsys (formulario firmado, sin red). */
async function checkout(qrToken: string, tipCents = 0): Promise<{ order: string; amountCents: number; tipCents: number | null }> {
  const out = await inVenue(undefined, () => payments.startCheckout(qrToken, { tipCents, method: 'card', language: 'es' }));
  if (out.kind !== 'checkout') throw new Error(`no se abrió el pago: ${out.kind}`);
  const attempt = await sys((tx) => tx.paymentAttempt.findFirstOrThrow({ where: { providerTxId: out.order } }));
  return { order: out.order, amountCents: attempt.amountCents!, tipCents: attempt.tipCents };
}

function signedRedsys(order: string, amount: number, paymentId: string): string {
  const fields = { Ds_Order: order, Ds_MerchantCode: MERCHANT, Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: String(amount), Ds_Currency: '978' };
  const s = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: order, ...fields } as never);
  return `Ds_SignatureVersion=${s.Ds_SignatureVersion}&Ds_MerchantParameters=${encodeURIComponent(s.Ds_MerchantParameters)}&Ds_Signature=${encodeURIComponent(s.Ds_Signature)}&_paymentId=${paymentId}`;
}

/** El aviso firmado de Redsys «aprobado por `amount`» llega y se procesa (como la cola de avisos). */
async function bankSays(l: Local, paymentId: string, order: string, amount: number): Promise<void> {
  const d = await prisma.webhookDelivery.create({
    data: { provider: 'REDSYS', tenantId: l.V, externalEventId: `ev-${randomUUID()}`, rawBody: Buffer.from(signedRedsys(order, amount, paymentId)), signature: 'x' },
  });
  await ingest.process({ data: { deliveryId: d.id.toString() } } as Job<{ deliveryId: string }>);
}

const paymentOf = (id: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { id } }));
const earningsOf = (paymentId: string) => sys((tx) => tx.operatorEarning.findMany({ where: { paymentId } }));
const walletOf = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));
const device = (l: Local): PosDevice => ({ terminalId: l.term, tenantId: l.V, label: 'Barra', zone: 'BARRA', tokenHash: 'x' });

beforeAll(async () => {
  await prisma.onModuleInit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── La migración ───────────────────────────────────────────────────────

const MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261030100000_comision_servicio/migration.sql');
const CHECKS = [
  ['venues', 'venues_service_fee_bps_range'],
  ['businesses', 'businesses_service_fee_bps_range'],
  ['payments', 'payments_service_fee_range'],
  ['wallet_cash_topups', 'wallet_cash_topups_service_fee_range'],
  ['wallet_consumptions', 'wallet_consumptions_platform_bps_range'],
  ['refunds', 'refunds_service_fee_nonneg'],
  ['payments', 'payments_available_in_range'],
] as const;

async function feeChecks(): Promise<Array<{ table: string; name: string; valid: boolean }>> {
  return prisma.$queryRawUnsafe(
    `SELECT conrelid::regclass::text AS table, conname AS name, convalidated AS valid FROM pg_constraint
      WHERE conname IN (${CHECKS.map(([, c]) => `'${c}'`).join(', ')}) ORDER BY conname`,
  );
}

function runMigration(): { status: number | null; out: string } {
  const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
  const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
    encoding: 'utf8',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

describe('la migración 20261030100000_comision_servicio', () => {
  it('los locales de antes, con la comisión apagada y al 10 %; los CHECK, validados', async () => {
    const found = await feeChecks();
    expect(found.map((c) => [c.table, c.name]).sort()).toEqual([...CHECKS].map((c) => [...c]).sort());
    expect(found.every((c) => c.valid)).toBe(true);
    const v = await sys((tx) => tx.venue.create({ data: { name: 'Antes', slug: `fee-antes-${r}` } }));
    expect(v).toMatchObject({ serviceFeeEnabled: false, serviceFeeBps: 1000, topUpServiceFeeBps: 1000 });
  });

  it('la base no deja un % fuera de 0–12 % ni una comisión negativa', async () => {
    const bad = (sql: string) => prisma.$executeRawUnsafe(sql).then(() => null, (e: unknown) => String((e as Error).message));
    expect(await bad(`UPDATE venues SET "serviceFeeBps" = 1201 WHERE slug = 'fee-antes-${r}'`)).toMatch(/venues_service_fee_bps_range/);
    expect(await bad(`UPDATE venues SET "topUpServiceFeeBps" = -1 WHERE slug = 'fee-antes-${r}'`)).toMatch(/venues_service_fee_bps_range/);
    expect(await bad(`UPDATE venues SET "serviceFeeBps" = 1200, "topUpServiceFeeBps" = 0 WHERE slug = 'fee-antes-${r}'`)).toBeNull();
  });

  it('lo devolvible de un pago directo llega a importe + comisión + propina (y no más)', async () => {
    const def = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'payments_available_in_range'`,
    );
    expect(def[0]?.def).toContain('serviceFeeCents');
  });

  it('se puede repetir: lo mismo, sin error', async () => {
    const before = await feeChecks();
    const again = runMigration();
    expect(again.status, again.out).toBe(0);
    expect(await feeChecks()).toEqual(before);
  }, 120_000);
});

// ─── Interruptor ENCENDIDO ──────────────────────────────────────────────

describe('con la comisión del servicio ENCENDIDA (10 % tarjeta y datáfono, 12 % recargas)', () => {
  let L: Local;
  let direct: string;
  let posPay: string;
  let cardWallet: string;
  let cardTopUpId: string;
  let cashWallet: string;
  let unico: { id: string; chargeId: string };

  beforeAll(async () => {
    L = await local('on', { enabled: true, cardBps: 1000, topUpBps: 1200 });
  });

  it('pago directo por Redsys: 33 € + 3,30 € de comisión + 2 € de propina = 38,30 € al banco', async () => {
    const c = await cobro(L);
    direct = c.id;
    expect(c).toMatchObject({ amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000 });
    const view = await inVenue(undefined, () => payments.getPayPage(c.qrToken));
    expect(view).toMatchObject({ kind: 'choose', amountCents: 3300, serviceFeeCents: 330, topUp: false });
    const opened = await checkout(c.qrToken, 200);
    expect(opened).toMatchObject({ amountCents: 3830, tipCents: 200 });
    await bankSays(L, c.id, opened.order, 3830);
    const p = await paymentOf(c.id);
    expect(p).toMatchObject({ status: 'AUTHORIZED', amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000, tipCents: 200, availableAmountCents: 3830, platformCommissionBps: 0 });
    // La chica: su 90 % del consumo (nunca de la comisión) y su propina.
    expect(await earningsOf(c.id)).toMatchObject([{ commissionCents: 2970, tipCents: 200, paymentAmountCents: 3300 }]);
    // Justificante y «Pagado».
    const receipt = await inVenue(undefined, () => payments.getReceipt(c.qrToken));
    expect(receipt).toMatchObject({ amountCents: 3300, serviceFeeCents: 330, tipCents: 200 });
    expect(await inVenue(undefined, () => payments.getByToken(c.qrToken))).toMatchObject({ amountCents: 3300, serviceFeeCents: 330, tipCents: 200 });
  });

  it('venta en el datáfono: el lector pide 36,30 € y el resultado tiene que casar con ese total', async () => {
    const c = await cobro(L, { captureMethod: 'POS_EXTERNAL' });
    posPay = c.id;
    const pending = await inVenue(L.V, () => pos.pending(device(L)));
    expect(pending.find((x) => x.id === c.id)).toMatchObject({ amountCents: 3630, baseAmountCents: 3300, serviceFeeCents: 330 });
    const started = await inVenue(L.V, () => pos.start(device(L), c.id));
    expect(started.amountCents).toBe(3630);
    const sale = (requestedAmount: number, op: string) => ({
      approved: true,
      authorisationCode: '047215',
      paytefOperationNumber: op,
      transactionReference: started.reference,
      requestedAmount,
    });
    // Sin la comisión, no cuadra (se anula en el datáfono).
    await expect(inVenue(L.V, () => pos.reportResult(device(L), c.id, sale(3300, `OP1${r}`)))).resolves.toMatchObject({ status: 'MISMATCH' });
    await expect(inVenue(L.V, () => pos.reportResult(device(L), c.id, sale(3630, `OP2${r}`)))).resolves.toMatchObject({ status: 'PAID' });
    expect(await paymentOf(c.id)).toMatchObject({ status: 'AUTHORIZED', serviceFeeCents: 330, availableAmountCents: 3630 });
    expect(await earningsOf(c.id)).toMatchObject([{ commissionCents: 2970, tipCents: 0 }]);
  });

  it('recarga con tarjeta al 12 %: el banco cobra 56 €, el saldo es 50 € (sin cobrar la comisión otra vez)', async () => {
    const c = await cardTopUp(L, 5000);
    cardTopUpId = c.id;
    cardWallet = c.walletId!;
    expect(c).toMatchObject({ amountCents: 5000, serviceFeeCents: 600, serviceFeeBps: 1200 });
    expect(await inVenue(undefined, () => payments.getPayPage(c.qrToken))).toMatchObject({ kind: 'choose', amountCents: 5000, serviceFeeCents: 600, topUp: true });
    const opened = await checkout(c.qrToken);
    expect(opened.amountCents).toBe(5600);
    // Un aviso por 50 € (sin la comisión) no la da por pagada: incidencia de importe.
    await bankSays(L, c.id, opened.order, 5000);
    expect((await paymentOf(c.id)).status).toBe('AUTHORIZING');
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId: c.id, eventType: 'payment.amount_mismatch' } }))).toBe(1);
    await bankSays(L, c.id, opened.order, 5600);
    expect(await paymentOf(c.id)).toMatchObject({ status: 'AUTHORIZED', amountCents: 5000, serviceFeeCents: 600, availableAmountCents: 5000 });
    expect(await walletOf(cardWallet)).toMatchObject({ balanceCents: 5000, status: 'ACTIVE' });
  });

  it('recarga en efectivo al 12 %: «Cobra 56 €», el saldo es 50 €; una pantalla que no cobra la comisión no carga nada', async () => {
    const owner = { userId: L.owner, role: 'OWNER' };
    const old = await inVenue(L.V, () => cash.topUp(L.V, owner, { amountCents: 5000, idempotencyKey: key(), wallet: { create: true } })).catch((e: unknown) => e);
    expect(old).toBeInstanceOf(ConflictException);
    expect(((old as ConflictException).getResponse() as { code: string }).code).toBe('SERVICE_FEE_APP_OUTDATED');
    const out = await inVenue(L.V, () => cash.topUp(L.V, owner, { amountCents: 5000, idempotencyKey: key(), wallet: { create: true }, serviceFeeCents: 600 }));
    cashWallet = out.walletId;
    expect(out).toMatchObject({ amountCents: 5000, serviceFeeCents: 600, serviceFeeBps: 1200, chargedCents: 5600, balanceCents: 5000 });
    expect(await sys((tx) => tx.walletCashTopUp.findUniqueOrThrow({ where: { id: out.topUpId } }))).toMatchObject({ amountCents: 5000, serviceFeeCents: 600, serviceFeeBps: 1200 });
  });

  it('cobro único pagado con el saldo: sin comisión del servicio (ya se cobró al recargar) y sin el % antiguo', async () => {
    const c = await cobro(L, { withSaldo: true });
    unico = { id: c.id, chargeId: c.saldo!.chargeId };
    expect(c.serviceFeeCents).toBe(330);
    const payToken = (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: unico.chargeId } }))).payToken!;
    const paid = await inVenue(undefined, () => charges.payQrCharge(payToken, cashWallet));
    expect(paid).toMatchObject({ amountCents: 3300, balanceCents: 1700 });
    expect((await paymentOf(c.id)).status).toBe('CANCELED');
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: cashWallet } }));
    // Saldo cargado con la comisión (la recarga en efectivo al 12 %): todo el consumo sin el % antiguo.
    expect(consumption).toMatchObject({ amountCents: 3300, platformCommissionBps: null, serviceFeeSaldoCents: 3300 });
    // La chica, su 90 % del consumo.
    expect(await sys((tx) => tx.operatorEarning.findMany({ where: { consumptionId: consumption.id } }))).toMatchObject([{ commissionCents: 2970 }]);
  });

  it('devolución parcial y luego total de un pago directo: su comisión vuelve en proporción y cuadra', async () => {
    // 11 € de 38,30 €: 0,95 € eran comisión del servicio; a la chica se le descuentan 9,10 €.
    await inVenue(L.V, () => refunds.refund({ paymentId: direct, amountCents: 1100, reason: 'Parte', idempotencyKey: randomUUID() }, ownerActor(L)));
    const first = await sys((tx) => tx.refund.findFirstOrThrow({ where: { paymentId: direct } }));
    expect(first).toMatchObject({ status: 'SUCCEEDED', amountCents: 1100, serviceFeeCents: 95 });
    expect(await earningsOf(direct)).toMatchObject([{ reversedCents: 910 }]);
    // El datáfono, devuelto entero: toda su comisión.
    await inVenue(L.V, () => refunds.refund({ paymentId: posPay, amountCents: 3630, reason: 'Todo', idempotencyKey: randomUUID() }, ownerActor(L)));
    expect(await sys((tx) => tx.refund.findFirstOrThrow({ where: { paymentId: posPay } }))).toMatchObject({ serviceFeeCents: 330 });
    expect(await paymentOf(posPay)).toMatchObject({ status: 'REFUNDED', availableAmountCents: 0 });
    expect(await earningsOf(posPay)).toMatchObject([{ reversedCents: 2970 }]);
  });

  it('«Devolver saldo»: solo el saldo (a la tarjeta lo que entró con tarjeta, en efectivo lo de efectivo); la comisión se queda', async () => {
    const preview = await inVenue(L.V, () => charges.payoutPreview(ownerActor(L), cardWallet));
    expect(preview).toMatchObject({ balanceCents: 5000, cashOutCents: 0, cardRefundCents: 5000 });
    await expect(inVenue(L.V, () => charges.payout(ownerActor(L), cardWallet, { method: 'CARD' }))).resolves.toMatchObject({ refundedCents: 5000 });
    const topUpRefund = await sys((tx) => tx.refund.findFirstOrThrow({ where: { paymentId: cardTopUpId } }));
    expect(topUpRefund).toMatchObject({ amountCents: 5000, serviceFeeCents: 0 });
    expect(await paymentOf(cardTopUpId)).toMatchObject({ availableAmountCents: 0, serviceFeeCents: 600 });
    // Efectivo: le quedan 17 € (entraron 50 € en efectivo): salen 17 €, no 56 € ni 50 €.
    const cashPreview = await inVenue(L.V, () => charges.payoutPreview(ownerActor(L), cashWallet));
    expect(cashPreview).toMatchObject({ balanceCents: 1700, cashOutCents: 1700, cardRefundCents: 0 });
    await expect(inVenue(L.V, () => charges.payout(ownerActor(L), cashWallet, { method: 'CASH' }))).resolves.toMatchObject({ refundedCents: 1700 });
    // El cierre cuenta hasta «ahora» con el reloj del proceso y la devolución lleva la hora de la
    // base: en Windows, Date.now() puede ir unos milisegundos por detrás (como copa-escenarios).
    const last = await sys((tx) => tx.walletPayout.findFirstOrThrow({ where: { tenantId: L.V }, orderBy: { createdAt: 'desc' } }));
    while (Date.now() <= last.createdAt.getTime()) await new Promise((done) => setTimeout(done, 5));
  });

  it('cierre de la noche: la caja cuadra con la comisión de las recargas en efectivo dentro (y se dice aparte)', async () => {
    const check = await inVenue(L.V, () => nights.closeCheck(L.V));
    // Fondo 100 € + 56 € de la recarga en efectivo − 17 € de saldo devuelto.
    expect(check.cash).toMatchObject({ cashInCents: 5600, walletCashTopUpsCents: 5000, walletCashTopUpFeesCents: 600, cashOutCents: 1700, expectedCents: 13_900 });
    // Lo de la caja, con la comisión del servicio en su línea.
    const efectivo = check.steps.find((s) => s.key === 'efectivo')!;
    expect(efectivo.items.map((i) => [i.id, i.amountCents])).toEqual([
      ['wallet-cash-topups', 5000],
      ['wallet-cash-topup-fees', 600],
      ['wallet-cash', -1700],
    ]);
    // Solo bloquea el efectivo sin contar (se cuenta al cerrar).
    expect(check.steps.filter((s) => s.status === 'block').map((s) => s.key)).toEqual(['efectivo']);
    const acknowledged = check.steps.filter((s) => s.status === 'warn').map((s) => s.key);
    const closed = await inVenue(L.V, () =>
      nights.close(L.V, { userId: L.owner, role: 'OWNER' }, L.nightId, { cashCountedCents: 13_900, acknowledged, note: 'comisión del servicio' }),
    );
    expect(closed.z.caja).toMatchObject({ expectedCents: 13_900, countedCents: 13_900, diffCents: 0, walletCashTopUpFeesCents: 600 });
  });

  it('el Z congelado, el mapa del dinero y la gestoría separan lo del local y lo de OxioPay; la chica, sobre el consumo', async () => {
    const night = await sys((tx) => tx.venueNight.findUniqueOrThrow({ where: { id: L.nightId } }));
    const z = night.zReport as unknown as NightZ;
    // Cobrada: 3,30 (Redsys) + 3,30 (datáfono) + 6 (tarjeta) + 6 (efectivo) = 18,60 €; devuelta 0,95 + 3,30.
    expect(z.summary).toMatchObject({ serviceFeeCents: 1860, serviceFeeCashCents: 600, serviceFeeRefundedCents: 425, serviceFeeNetCents: 1435 });
    const s = z.summary;
    expect(s.venueNetCents + s.chicaNetCents + (s.camareroNetCents ?? 0) + (s.serviceFeeNetCents ?? 0)).toBe(s.netCents);
    // Lo de Lola: 3 × 29,70 € + 2 € de propina − 9,10 − 29,70 devueltos.
    expect(s.chicaNetCents).toBe(3 * 2970 + 200 - 910 - 2970);
    expect(s.byType.find((t) => t.label === 'Comisión del servicio')).toMatchObject({ chargedCents: 1860 });

    const m = (z.moneyMap ?? null) as MoneyMap | null;
    expect(m).not.toBeNull();
    expect(m!.serviceFee).toEqual({ salesCents: 660, topUpsCents: 1200, cashCents: 600, refundedCents: 425, owedCents: 1435 });
    // El local ya no paga el % antiguo en ninguna de estas ventas.
    expect(m!.split.commissions.platformCents).toBe(0);
    const o = m!.where.owners;
    expect(o.oxioPayCents).toBe(1435);
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0)).toBe(m!.where.totalCents);
    expect(m!.where.cashBoxCents).toBe(13_900);
    // El mapa del panel (la noche cerrada) es el congelado.
    const panel = await inVenue(L.V, () => moneyMap.forQuery(L.V, { night: L.nightId }));
    expect(panel.serviceFee).toEqual(m!.serviceFee);

    // CSV de la gestoría: la columna «Comisión del servicio» y la parte de OxioPay aparte.
    const window = { from: new Date(z.from), to: new Date(z.to) };
    const rows = await inVenue(L.V, () => reports.cobros(L.V, window));
    const [header, ...body] = lines(cobrosCsv(rows, 'Sala on'));
    const cols = header!.split(';');
    const directRow = body.find((row) => row.includes(direct))!.split(';');
    const at = (name: string) => directRow[cols.indexOf(name)];
    expect([at('Importe'), at('Propina'), at('Comisión del servicio'), at('Total cobrado'), at('Devuelto')]).toEqual(['33,00', '2,00', '3,30', '38,30', '11,00']);
    // Parte OxioPay: 3,30 − 0,95; la chica: 29,70 + 2 − 9,10.
    expect([at('Parte chica'), at('Parte OxioPay')]).toEqual(['22,60', '2,35']);
    // El local: su 3,30 € (el 10 % del consumo) menos su parte de lo devuelto (0,95 €) = 27,30 − 22,60 − 2,35.
    expect(at('Parte local')).toBe('2,35');
    const cashCsv = lines(recargasEfectivoCsv(await inVenue(L.V, () => reports.recargasEfectivo(L.V, window))));
    const cashCols = cashCsv[0]!.split(';');
    expect(cashCsv[1]!.split(';')[cashCols.indexOf('Cobrado')]).toBe('56,00');
    const parsed = parseReportPeriod(new Date(z.from).toISOString().slice(0, 10), new Date(z.to).toISOString().slice(0, 10));
    if (!parsed.ok) throw new Error(parsed.error);
    const resumen = resumenCsv({ venueName: 'Sala on', period: parsed.period, generatedAt: new Date(), summary: s });
    expect(resumen).toContain('Comisión del servicio · se debe a OxioPay;14,35');

    // Totales del periodo (métricas, Z del periodo, 303): la comisión aparte, fuera de la base del local.
    const totals = await inVenue(L.V, () => period.totals(L.V, window));
    expect(totals).toMatchObject({ serviceFeeCents: 1260, walletCashTopUpFeeCents: 600, refundedServiceFeeCents: 425 });

    // La ficha de la chica: lo vendido es el consumo (33 €), no el total con la comisión.
    const ficha = await inVenue(L.V, () => fichas.ficha(L.V, L.lola, soon()));
    expect(ficha.rows.filter((row) => !row.refundOf).every((row) => row.amountCents === 3300 || row.amountCents === 3500)).toBe(true);
  });
});

// ─── Interruptor APAGADO: todo como hoy ─────────────────────────────────

describe('con la comisión del servicio APAGADA: todo exactamente como hoy', () => {
  let L: Local;

  beforeAll(async () => {
    L = await local('off', { enabled: false, cardBps: 1200, topUpBps: 1200 });
  });

  it('pago directo con propina: al banco 35 €, sin comisión y con el % antiguo de OxioPay', async () => {
    const c = await cobro(L);
    expect(c).toMatchObject({ amountCents: 3300, serviceFeeCents: 0, serviceFeeBps: null });
    const opened = await checkout(c.qrToken, 200);
    expect(opened.amountCents).toBe(3500);
    await bankSays(L, c.id, opened.order, 3500);
    expect(await paymentOf(c.id)).toMatchObject({ status: 'AUTHORIZED', serviceFeeCents: 0, serviceFeeBps: null, availableAmountCents: 3500, platformCommissionBps: 1000 });
    const view = await inVenue(undefined, () => payments.getReceipt(c.qrToken));
    expect(view).toMatchObject({ amountCents: 3300, serviceFeeCents: 0, tipCents: 200 });
  });

  it('datáfono, recargas (la app anterior también) y el saldo: sin comisión, el consumo con el % del local', async () => {
    const p = await cobro(L, { captureMethod: 'POS_EXTERNAL' });
    const started = await inVenue(L.V, () => pos.start(device(L), p.id));
    expect(started).toMatchObject({ amountCents: 3300, serviceFeeCents: 0 });
    const top = await cardTopUp(L, 5000);
    expect((await checkout(top.qrToken)).amountCents).toBe(5000);
    const out = await inVenue(L.V, () => cash.topUp(L.V, { userId: L.owner, role: 'OWNER' }, { amountCents: 5000, idempotencyKey: key(), wallet: { create: true } }));
    expect(out).toMatchObject({ amountCents: 5000, serviceFeeCents: 0, chargedCents: 5000, balanceCents: 5000 });
    const c = await cobro(L, { withSaldo: true });
    const payToken = (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId } }))).payToken!;
    await inVenue(undefined, () => charges.payQrCharge(payToken, out.walletId));
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: out.walletId } }));
    expect(consumption.platformCommissionBps).toBeNull();
  });

  it('el mapa, el resumen y la caja: sin comisión del servicio y con el 10 % antiguo, como hoy', async () => {
    const m = await inVenue(L.V, () => moneyMap.forQuery(L.V, {}, soon()));
    // Sin comisión del servicio, el mapa de siempre: ni sus campos.
    expect(m).not.toHaveProperty('serviceFee');
    expect(m.inflow).not.toHaveProperty('serviceFeeCents');
    expect(m.outflow).not.toHaveProperty('serviceFeeCents');
    expect(Object.keys(m.where.owners).sort()).toEqual(['saldoCents', 'staffCents', 'venueCents']);
    // 10 % de lo vendido sin propinas: 33 € con tarjeta + 33 € del saldo.
    expect(m.split.commissions.platformCents).toBe(330 + 330);
    // BBVA: 35 € de la venta (la recarga con tarjeta sigue en el banco sin aprobar).
    expect(m.where.bbvaCents).toBe(3500);
    const check = await inVenue(L.V, () => nights.closeCheck(L.V));
    expect(check.cash).toMatchObject({ cashInCents: 5000, walletCashTopUpsCents: 5000, expectedCents: 15_000 });
    expect(check.cash).not.toHaveProperty('walletCashTopUpFeesCents');
    expect(check.steps.find((st) => st.key === 'efectivo')!.items.map((i) => i.id)).not.toContain('wallet-cash-topup-fees');
    const window = { from: ago(3 * HOUR), to: soon() };
    const rows = await inVenue(L.V, () => reports.cobros(L.V, window));
    const recargas = await inVenue(L.V, () => reports.recargasEfectivo(L.V, window));
    const s = summarize(rows, [], [], [], [], recargas);
    expect(s).toMatchObject({ chargedCents: 3300 + 200 + 5000 });
    expect(s).not.toHaveProperty('serviceFeeCents');
    expect(s.byType.map((t) => t.label)).not.toContain('Comisión del servicio');
    expect(s.venueNetCents).toBe(s.netCents - s.chicaNetCents);
    // Los CSV de la gestoría, los de siempre (sin las columnas de la comisión).
    expect(lines(cobrosCsv(rows, 'Sala off'))[0]).not.toContain('Comisión del servicio');
    expect(lines(recargasEfectivoCsv(recargas))[0]).not.toContain('Comisión del servicio');
    // Los totales del periodo, también.
    const totals = await inVenue(L.V, () => period.totals(L.V, window));
    expect(totals).not.toHaveProperty('serviceFeeCents');
  });
});

// ─── Encenderla no cambia lo ya creado ──────────────────────────────────

describe('encender la comisión del servicio no cambia los cobros ya creados', () => {
  it('un QR creado con la comisión apagada se cobra con su importe de siempre aunque se encienda después', async () => {
    const L = await local('cambio', { enabled: false });
    const c = await cobro(L);
    await sys((tx) => tx.venue.update({ where: { id: L.V }, data: { serviceFeeEnabled: true, serviceFeeBps: 1200 } }));
    const opened = await checkout(c.qrToken);
    expect(opened.amountCents).toBe(3300);
    // Uno nuevo, ya con la comisión del momento (12 %).
    const nuevo = await cobro(L);
    expect(nuevo).toMatchObject({ serviceFeeBps: 1200, serviceFeeCents: 396 });
    // Y cambiar el % después no reescribe lo apuntado.
    await sys((tx) => tx.venue.update({ where: { id: L.V }, data: { serviceFeeBps: 500 } }));
    expect(await paymentOf(nuevo.id)).toMatchObject({ serviceFeeBps: 1200, serviceFeeCents: 396 });
    expect((await checkout(nuevo.qrToken)).amountCents).toBe(3300 + 396);
  });
});

// ─── Ronda de revisión ─────────────────────────────────────────────────

/** Gastar del saldo `walletId` el servicio de la carta (33 €), con el QR del cobro del saldo. */
async function spend(l: Local, walletId: string): Promise<{ id: string; serviceFeeSaldoCents: number; platformCommissionBps: number | null }> {
  const c = await cobro(l, { withSaldo: true });
  const payToken = (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId } }))).payToken!;
  await inVenue(undefined, () => charges.payQrCharge(payToken, walletId));
  const request = await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId } }));
  return sys((tx) =>
    tx.walletConsumption.findUniqueOrThrow({
      where: { id: request.consumptionId! },
      select: { id: true, serviceFeeSaldoCents: true, platformCommissionBps: true },
    }),
  );
}

const setSwitch = (l: Local, on: boolean) => sys((tx) => tx.venue.update({ where: { id: l.V }, data: { serviceFeeEnabled: on } }));
const cashIn = (l: Local, amountCents: number, wallet: Record<string, unknown>, serviceFeeCents?: number) =>
  inVenue(l.V, () =>
    cash.topUp(l.V, { userId: l.owner, role: 'OWNER' }, {
      amountCents,
      idempotencyKey: key(),
      wallet,
      ...(serviceFeeCents === undefined ? {} : { serviceFeeCents }),
    } as never),
  );

describe('la migración 20261030110000_comision_saldo', () => {
  const SALDO_MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261030110000_comision_saldo/migration.sql');
  const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
  const constraint = () =>
    prisma.$queryRawUnsafe<Array<{ valid: boolean; def: string }>>(
      `SELECT convalidated AS valid, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'wallet_consumptions_fee_saldo_range'`,
    );

  it('«serviceFeeSaldoCents» a 0 de fábrica, con su CHECK validado (de 0 al importe); repetirla no cambia nada', async () => {
    expect(await constraint()).toEqual([{ valid: true, def: expect.stringContaining('"serviceFeeSaldoCents" <= "amountCents"') }]);
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', SALDO_MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status).toBe(0);
    expect(await constraint()).toHaveLength(1);
  });
});

describe('saldo cargado con y sin comisión del servicio (decisión del dueño): lo más antiguo primero', () => {
  it('20 € de antes de encenderla y 50 € con ella: 33 € del saldo = 20 € con el % antiguo + 13 € sin él; apagada, cuadra igual', async () => {
    const L = await local('saldo', { enabled: false, topUpBps: 1200 });
    // Con el interruptor apagado: 20 € sin comisión.
    const first = await cashIn(L, 2000, { create: true });
    const code = (await walletOf(first.walletId)).shortCode!;
    // Se enciende: 50 € + 6 € de comisión al mismo saldo.
    await setSwitch(L, true);
    await cashIn(L, 5000, { code }, 600);
    expect(await walletOf(first.walletId)).toMatchObject({ balanceCents: 7000 });
    const a = await spend(L, first.walletId);
    expect(a).toMatchObject({ serviceFeeSaldoCents: 1300, platformCommissionBps: null });
    // El mapa del dinero: el 10 % antiguo solo de los 20 € cargados sin comisión.
    const m1 = await inVenue(L.V, () => moneyMap.forQuery(L.V, {}, soon()));
    expect(m1.split.commissions.platformCents).toBe(200);
    // Se apaga: lo que queda (37 €) se cargó con comisión → sin el % antiguo aunque esté apagada.
    await setSwitch(L, false);
    const b = await spend(L, first.walletId);
    expect(b).toMatchObject({ serviceFeeSaldoCents: 3300, platformCommissionBps: null });
    const m2 = await inVenue(L.V, () => moneyMap.forQuery(L.V, {}, soon()));
    expect(m2.split.commissions.platformCents).toBe(200);
    expect(await walletOf(first.walletId)).toMatchObject({ balanceCents: 400 });
  });

  it('todo cargado sin comisión: con el interruptor encendido sigue pagando el % antiguo (como hoy)', async () => {
    const L = await local('viejo', { enabled: false });
    const t = await cashIn(L, 5000, { create: true });
    await setSwitch(L, true);
    expect(await spend(L, t.walletId)).toMatchObject({ serviceFeeSaldoCents: 0, platformCommissionBps: null });
    const m = await inVenue(L.V, () => moneyMap.forQuery(L.V, {}, soon()));
    expect(m.split.commissions.platformCents).toBe(330);
  });
});

describe('datáfono manual (POS_EXTERNAL) con la comisión: se confirma lo que se cobró', () => {
  it('sin el total (app de antes) 409 SERVICE_FEE_APP_OUTDATED; 33 € 409 POS_CHARGE_MISMATCH; 36,30 € se confirma', async () => {
    const L = await local('pos', { enabled: true });
    const c = await cobro(L, { captureMethod: 'POS_EXTERNAL' });
    const confirm = (extra: Record<string, unknown>) =>
      inVenue(L.V, () => payments.confirmPosPayment(c.id, ownerActor(L), { posReceiptRef: 'AB12CD', ...extra }));
    const codeOf = (err: unknown) => ((err as ConflictException).getResponse() as { code?: string }).code;
    expect(codeOf(await confirm({}).catch((e: unknown) => e))).toBe('SERVICE_FEE_APP_OUTDATED');
    expect(codeOf(await confirm({ chargedCents: 3300 }).catch((e: unknown) => e))).toBe('POS_CHARGE_MISMATCH');
    expect((await paymentOf(c.id)).status).toBe('CREATED');
    await confirm({ chargedCents: 3630 });
    expect(await paymentOf(c.id)).toMatchObject({ status: 'AUTHORIZED', serviceFeeCents: 330, availableAmountCents: 3630, authCode: 'AB12CD' });
  });
});

describe('anular una recarga en efectivo con la comisión: la pantalla tiene que enseñar lo que sale de la caja', () => {
  it('sin la comisión (pantalla de antes): 409 y no se anula; con ella, salen saldo + comisión', async () => {
    const L = await local('anula', { enabled: true, topUpBps: 1200 });
    const t = await cashIn(L, 10_000, { create: true }, 1200);
    const manager = { userId: L.owner, role: 'OWNER' as const, tenantId: L.V };
    const old = await inVenue(L.V, () => cash.voidTopUp(manager, t.topUpId, { reason: 'mal tecleada', totpCode: '123456' })).catch((e: unknown) => e);
    expect(((old as ConflictException).getResponse() as { code: string }).code).toBe('SERVICE_FEE_APP_OUTDATED');
    expect(await walletOf(t.walletId)).toMatchObject({ balanceCents: 10_000 });
    const out = await inVenue(L.V, () => cash.voidTopUp(manager, t.topUpId, { reason: 'mal tecleada', totpCode: '123456', serviceFeeCents: 1200 }));
    expect(out).toMatchObject({ amountCents: 10_000, serviceFeeCents: 1200, balanceCents: 0 });
    // La caja: entra 112 € y sale lo mismo (la hora de Postgres puede ir unos ms por delante de la de Node).
    const voidRow = await sys((tx) => tx.walletCashTopUp.findUniqueOrThrow({ where: { voidOfId: t.topUpId } }));
    expect(voidRow).toMatchObject({ amountCents: -10_000, serviceFeeCents: -1200 });
    while (Date.now() <= voidRow.createdAt.getTime()) await new Promise((done) => setTimeout(done, 5));
    const check = await inVenue(L.V, () => nights.closeCheck(L.V));
    expect(check.cash.cashInCents).toBe(0);
  });
});

describe('copa con invitación devuelta en parte, con la comisión: la ficha descuenta como el pago real', () => {
  it('33 € + 3,30 € + 2 € de propina, devueltos 11 €: a la invitada se le descuenta 11 / 38,30 de su parte', async () => {
    const L = await local('invita', { enabled: true });
    const pay = await sys((tx) =>
      tx.payment.create({
        data: {
          tenantId: L.V, terminalId: L.term, idempotencyKey: key(), amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000, tipCents: 200,
          availableAmountCents: 3830 - 1100, qrToken: `inv-${randomUUID()}`, qrExpiresAt: ago(-HOUR), status: 'PARTIALLY_REFUNDED',
          provider: 'REDSYS', providerTxId: `INV${randomBytes(4).toString('hex')}`, revenueCategory: 'VENUE_BAR', authorizedAt: ago(30 * 60_000),
          platformCommissionBps: 0,
        },
      }),
    );
    await sys(async (tx) => {
      await tx.paymentLine.create({
        data: {
          tenantId: L.V, paymentId: pay.id, category: 'VENUE_BAR', label: 'Copa con invitación', qty: 1, unitCents: 3300, amountCents: 3300,
          beneficiaryOperatorId: L.lola, beneficiaryCents: 1650, chargerCents: 0,
        },
      });
      await tx.refund.create({ data: { tenantId: L.V, paymentId: pay.id, amountCents: 1100, requestedBy: L.owner, status: 'SUCCEEDED', serviceFeeCents: 95 } });
    });
    const totals = await inVenue(L.V, () => prisma.withTenant(L.V, (tx) => invitationTotals(tx, L.V, L.lola)));
    // 1650 − round(1650 × 1100 / 3830) = 1650 − 474 (sin la comisión serían 519).
    expect(totals).toEqual({ count: 1, amountCents: 3300, shareCents: 1176 });
  });
});
