// Integración (Postgres real, np_app con FORCE RLS): «Cobros» en la app de la
// chica. Un cobro único (tarjeta y saldo a la vez) que hace ella y que el
// cliente paga con la ficha NFC sale UNA vez, como el del saldo y pagado (la
// app enseñaba el cobro con tarjeta que se canceló solo: «Cancelado»).
// Pagado con tarjeta, la fila de la tarjeta pagada; cancelado de verdad,
// cancelado; el banco aprueba la tarjeta después de la ficha, las dos, la de
// tarjeta marcada «cobrado dos veces» como en el panel. En la lista de la app
// (/staff/me/cobros) y en la de antes (/operators/me/payments, la de la app
// vieja mientras se despliega). Y lo que ve cuadra con su ficha del panel:
// el importe y lo suyo. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { Job } from 'bullmq';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { OwnCobrosController } from '../../src/modules/money-map/own-cobros.controller';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { ReportsService } from '../../src/modules/reports/reports.service';

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
const cobros = new CobrosService(prisma);
const moneyMap = new MoneyMapService(prisma, new ReportsService(prisma), config as never);
const fichas = new StaffFichaService(prisma, moneyMap);
const own = new OwnCobrosController(cobros, moneyMap);
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, {} as never, {} as never);

// Una pasarela de mentira (Paytef) para la tarjeta aprobada después de la
// ficha: devuelve el cargo sola o no puede (y queda «a devolver»).
let refundStatus: 'SUCCEEDED' | 'FAILED' = 'FAILED';
const gateway = {
  provider: 'PAYTEF',
  mapWebhookToFsmEvent: (p: Record<string, unknown>) => ({
    paymentId: String(p._paymentId),
    event: { type: 'AUTHORIZED', providerTxId: String(p.order), provider: 'PAYTEF' },
  }),
  proveApproval: async () => ({ kind: 'confirmed', amountCents: 12_000, currency: 'EUR' }),
  refund: async (input: { reference: string }) => ({ providerRefundId: `RF-${input.reference}`, status: refundStatus }),
  getStatus: async () => 'AUTHORIZED',
};
const ingest = new WebhookIngestProcessor(prisma as never, payments as never, { get: () => gateway } as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60_000;
/** El «ahora» de la ficha, un segundo por delante (la hora de Postgres puede ir unos ms por delante de la de Node). */
const soon = () => new Date(Date.now() + 1_000);
let V: string, nerea: string, carlos: string, hora: string, copa: string;
let n = 0;
const key = () => `cch-${r}-${(n += 1)}`;
const nereaActor = () => ({ userId: nerea, role: 'OPERATOR' as const, tenantId: V });
const nereaJwt = () => ({ sub: nerea, tenantId: V, role: 'OPERATOR' }) as JwtPayload;

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo del cliente con su ficha NFC y PIN 4827. */
async function wallet(balanceCents: number): Promise<{ id: string; card: string; uid: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `cch-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gcch-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V } });
    return w.id;
  });
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  return { id, card, uid };
}

/** El cobro único de «Cobrar» (tarjeta y saldo a la vez), hecho por quien se diga. */
const cobro = (by: { userId: string; role: 'OPERATOR' | 'WAITER' }, serviceItemId: string) =>
  inVenue(V, () =>
    payments.create(
      V,
      key(),
      { currency: 'EUR', terminalExternalId: `CCH-${r}`, lines: [{ serviceItemId, qty: 1 }], withSaldo: true } as never,
      by,
    ),
  );
const deNerea = () => cobro({ userId: nerea, role: 'OPERATOR' }, hora);

type Actor = { userId: string; role: 'OPERATOR' | 'WAITER'; tenantId: string };
/** El cliente acerca la ficha al móvil de quien cobra y pone su PIN (pasa de los 20 € sin PIN). */
const payNfc = (chargeId: string, w: { card: string; uid: string }, actor: Actor = nereaActor()) =>
  inVenue(V, () => charges.payQrChargeWithPin(actor, chargeId, { card: w.card, uid: w.uid, pin: '4827' }));

/** El cliente abrió el pago con tarjeta en el banco: AUTHORIZING con su pedido. */
async function atTheBank(paymentId: string, order: string, amountCents: number, provider: 'REDSYS' | 'PAYTEF' = 'REDSYS') {
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider, providerTxId: order } });
    await tx.paymentAttempt.create({ data: { paymentId, tenantId: V, provider, providerTxId: order, amountCents, tipCents: 0 } });
  });
}
const approveCard = (paymentId: string, order: string) =>
  inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));

/** El aviso del banco (Paytef) de la tarjeta aprobada. */
async function bankNotice(paymentId: string, order: string): Promise<void> {
  const d = await prisma.webhookDelivery.create({
    data: {
      provider: 'PAYTEF',
      tenantId: V,
      externalEventId: `ev-${randomUUID()}`,
      rawBody: Buffer.from(`order=${order}&_paymentId=${paymentId}`),
      signature: 'x',
    },
  });
  await ingest.process({ data: { deliveryId: d.id.toString() } } as Job<{ deliveryId: string }>);
}

/** «Cobros» de la app de la chica (/staff/me/cobros): las filas de ese cobro (por su referencia). */
async function appRows(ref: string | null) {
  const page = await inVenue(V, () => own.list(nereaJwt(), { limit: 50 }));
  return page.items.filter((x) => x.ref === ref);
}
/** La lista de la app vieja (/operators/me/payments): las filas de ese cobro (su tarjeta o su saldo). */
async function oldAppRows(c: { id: string; saldo: { chargeId: string } | null }) {
  const ids = [c.id, c.saldo?.chargeId];
  const rows = await inVenue(V, () => operators.getMyPayments(nerea, V));
  return rows.filter((x) => ids.includes(x.id));
}
const shape = (rows: ReadonlyArray<{ kind?: string; status: string }>) => rows.map((x) => `${x.kind} ${x.status}`).sort();

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (
      await tx.venue.create({ data: { name: 'Sala Luna', slug: `cch-${r}`, walletGroup: `gcch-${r}`, platformCommissionBps: 0 } })
    ).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `CCH-${r}`, label: 'Barra', zone: 'BARRA' } });
    nerea = (
      await tx.user.create({
        data: { tenantId: V, email: `nerea-cch-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Nerea' },
      })
    ).id;
    carlos = (
      await tx.user.create({ data: { tenantId: V, email: `carlos-cch-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Carlos' } })
    ).id;
    hora = (await tx.serviceItem.create({ data: { tenantId: V, name: '1 h', priceCents: 12_000, category: 'CHICA_SERVICE' } })).id;
    copa = (await tx.serviceItem.create({ data: { tenantId: V, name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' } })).id;
    // La noche abierta hace 2 h (la ventana de su ficha en el panel).
    await tx.venueNight.create({ data: { tenantId: V, openedAt: new Date(Date.now() - 2 * HOUR) } });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cobro único de la chica pagado con la ficha NFC', () => {
  it('en su app, una sola fila: la del saldo, pagada (sin el cobro con tarjeta cancelado)', async () => {
    const w = await wallet(20_000);
    const c = await deNerea();
    await payNfc(c.saldo!.chargeId, w);
    const rows = await appRows(c.ref);
    expect(shape(rows)).toEqual(['SALDO ACCEPTED']);
    expect(rows[0]).toMatchObject({ id: c.saldo!.chargeId, amountCents: 12_000, service: '1 h', via: 'PIN', paidTwice: null });
    expect(rows[0]!.methodLabel).toMatch(/^Saldo /);
  });

  it('en la app vieja, igual: el cobro del saldo pagado y ninguna fila «Cancelado»', async () => {
    const w = await wallet(20_000);
    const c = await deNerea();
    await payNfc(c.saldo!.chargeId, w);
    const rows = await oldAppRows(c);
    expect(rows).toEqual([expect.objectContaining({ kind: 'SALDO', id: c.saldo!.chargeId, status: 'AUTHORIZED', amountCents: 12_000 })]);
  });

  it('cuadra con su ficha del panel: el mismo cobro, el mismo importe y lo suyo (90 %) una sola vez', async () => {
    const w = await wallet(20_000);
    const c = await deNerea();
    await payNfc(c.saldo!.chargeId, w);
    const [mine] = await appRows(c.ref);
    const ficha = await inVenue(V, () => fichas.ficha(V, nerea, soon()));
    const inFicha = ficha.rows.filter((x) => x.ref === c.ref);
    expect(inFicha).toHaveLength(1);
    expect(inFicha[0]).toMatchObject({ kind: 'SALDO', amountCents: mine!.amountCents, shareCents: 10_800 });
    const earnings = await inVenue(V, () => operators.getMyEarnings(nerea, V));
    expect(earnings.filter((e) => e.id === inFicha[0]!.id).map((e) => e.netCents)).toEqual([10_800]);
  });
});

describe('los demás casos, como en el panel', () => {
  it('pagado con tarjeta: una fila, la de la tarjeta pagada (también en la app vieja)', async () => {
    const c = await deNerea();
    const order = `CT${r}`;
    await atTheBank(c.id, order, 12_000);
    await approveCard(c.id, order);
    expect(shape(await appRows(c.ref))).toEqual(['PAYMENT AUTHORIZED']);
    const old = await oldAppRows(c);
    expect(old).toEqual([expect.objectContaining({ kind: 'PAYMENT', id: c.id, status: 'AUTHORIZED', qrToken: c.qrToken })]);
  });

  it('cancelado de verdad (lo cancela ella): una fila «Cancelado» (también en la app vieja)', async () => {
    const c = await deNerea();
    await inVenue(V, () => payments.cancel(c.id, nereaActor()));
    expect(shape(await appRows(c.ref))).toEqual(['PAYMENT CANCELED']);
    expect(shape(await oldAppRows(c))).toEqual(['PAYMENT CANCELED']);
  });

  it('sin pagar todavía: una fila pendiente, la de la tarjeta (la que ella puede cancelar)', async () => {
    const c = await deNerea();
    expect(shape(await appRows(c.ref))).toEqual(['PAYMENT CREATED']);
    expect(shape(await oldAppRows(c))).toEqual(['PAYMENT CREATED']);
  });

  it('cobrado dos veces (el banco aprueba la tarjeta después de la ficha): las dos, la de tarjeta marcada «a devolver»', async () => {
    refundStatus = 'FAILED';
    const w = await wallet(20_000);
    const c = await deNerea();
    const order = `TW${r}`;
    await atTheBank(c.id, order, 12_000, 'PAYTEF');
    await payNfc(c.saldo!.chargeId, w);
    await bankNotice(c.id, order);
    const rows = await appRows(c.ref);
    expect(shape(rows)).toEqual(['PAYMENT CANCELED', 'SALDO ACCEPTED']);
    expect(rows.find((x) => x.kind === 'PAYMENT')!.paidTwice).toEqual({ amountCents: 12_000, refunded: false });
    expect(rows.find((x) => x.kind === 'SALDO')!.paidTwice).toBeNull();
    expect(shape(await oldAppRows(c))).toEqual(['PAYMENT CANCELED', 'SALDO AUTHORIZED']);
  });

  it('cobrado dos veces y la pasarela lo devolvió sola: marcada «devuelto solo»', async () => {
    refundStatus = 'SUCCEEDED';
    const w = await wallet(20_000);
    const c = await deNerea();
    const order = `TR${r}`;
    await atTheBank(c.id, order, 12_000, 'PAYTEF');
    await payNfc(c.saldo!.chargeId, w);
    await bankNotice(c.id, order);
    const rows = await appRows(c.ref);
    expect(rows.find((x) => x.kind === 'PAYMENT')!.paidTwice).toEqual({ amountCents: 12_000, refunded: true });
  });

  it('el cobro del saldo de la pestaña «Saldo» también sale en la app vieja, pagado', async () => {
    const w = await wallet(20_000);
    const qr = await inVenue(V, () => charges.createQrCharge(nereaActor(), { serviceItemId: hora }));
    await payNfc(qr.id, w);
    const rows = (await inVenue(V, () => operators.getMyPayments(nerea, V))).filter((x) => x.id === qr.id);
    expect(rows).toEqual([expect.objectContaining({ kind: 'SALDO', status: 'AUTHORIZED', amountCents: 12_000 })]);
  });

  it('los cobros de otra persona del local no salen en sus listas', async () => {
    const w = await wallet(5000);
    const c = await cobro({ userId: carlos, role: 'WAITER' }, copa);
    await payNfc(c.saldo!.chargeId, w, { userId: carlos, role: 'WAITER', tenantId: V });
    expect(await appRows(c.ref)).toEqual([]);
    expect(await oldAppRows(c)).toEqual([]);
  });
});
