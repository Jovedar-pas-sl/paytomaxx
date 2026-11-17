// Integración (Postgres real): el cobro único. Un cobro con tarjeta y su cobro
// del saldo enlazado (misma referencia, mismo importe, un solo juego de
// líneas): gana el primero que se paga, con la fila del cobro bloqueada. Las
// dos carreras (tarjeta contra NFC y tarjeta contra Face ID), el NFC después
// de la tarjeta («Ya está pagado»), la tarjeta aprobada después del saldo
// (se devuelve sola o «cobrado dos veces» en Incidencias), cancelar, la página
// de pago y las apps antiguas. Y «Mi noche» de la chica invitada: solo su
// parte. np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { ConflictException } from '@nestjs/common';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { ALREADY_PAID_CODE, CobrosQuerySchema, confirmationCode } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { InvalidTransitionError } from '../../src/modules/payments/payment.machine';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { RedsysAdapter } from '../../src/modules/gateways/redsys.adapter';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { OrphanReconcileProcessor } from '../../src/modules/queues/orphan-reconcile.processor';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
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
const incidents = new IncidentsService(prisma as never, audit as never);
const reports = new ReportsService(prisma as never);
const checks = new CloseCheckService(prisma as never, {} as never, { get: () => undefined } as never);
const nights = new NightsService(prisma as never, reports, audit as never, checks);

// Redsys de verdad para el aviso firmado (su devolución por API no existe: se
// devuelve desde el portal del banco → incidencia). Y una pasarela de mentira
// que sí devuelve, para el caso bueno.
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
const refunds: Array<{ reference: string; amountCents: number }> = [];
const refundingGateway = {
  provider: 'PAYTEF',
  mapWebhookToFsmEvent: (p: Record<string, unknown>) => ({
    paymentId: String(p._paymentId),
    event: { type: 'AUTHORIZED', providerTxId: String(p.order), provider: 'PAYTEF' },
  }),
  proveApproval: async () => ({ kind: 'confirmed', amountCents: 1000, currency: 'EUR' }),
  refund: async (input: { reference: string; amountCents: number }) => {
    refunds.push(input);
    return { providerRefundId: `RF-${input.reference}`, status: 'SUCCEEDED' };
  },
  getStatus: async () => 'AUTHORIZED',
};
const registry = { get: (p: string) => (p === 'PAYTEF' ? refundingGateway : redsys) };
const ingest = new WebhookIngestProcessor(prisma as never, payments as never, registry as never);
// La conciliación pregunta a la pasarela (sin red: Redsys «aprobado»).
const redsysStatus = { provider: 'REDSYS', getStatus: async () => 'AUTHORIZED' };
const reconcile = new OrphanReconcileProcessor(
  prisma as never,
  payments as never,
  { get: (p: string) => (p === 'PAYTEF' ? refundingGateway : redsysStatus) } as never,
);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string, carlos: string, nerea: string, copa: string, invita: string;
let n = 0;
const key = () => `cu-${r}-${(n += 1)}`;
const asCarlos = () => ({ userId: carlos, role: 'WAITER' as const });
const carlosActor = () => ({ userId: carlos, role: 'WAITER' as const, tenantId: V });

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo del cliente con su NFC (y su número de serie) y PIN 4827. */
async function wallet(balanceCents: number): Promise<{ id: string; card: string; uid: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `cu-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gcu-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V } });
    return w.id;
  });
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  return { id, card, uid };
}

/** El cobro de la pantalla «Cobrar»: líneas de la carta, con el saldo enlazado (apps nuevas). */
const cobro = (lines: Array<{ serviceItemId: string; qty?: number }>, extra: Record<string, unknown> = {}) =>
  inVenue(V, () =>
    payments.create(
      V,
      key(),
      { currency: 'EUR', terminalExternalId: `CU-${r}`, lines: lines.map((l) => ({ qty: 1, ...l })), withSaldo: true, ...extra } as never,
      asCarlos(),
    ),
  );

const payNfc = (chargeId: string, w: { card: string; uid: string }) =>
  inVenue(V, () => charges.payQrChargeWithCard(carlosActor(), chargeId, { card: w.card, uid: w.uid }));
const payTokenOf = async (chargeId: string) =>
  (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: chargeId } }))).payToken!;
const payFaceId = async (chargeId: string, walletId: string) =>
  inVenue(undefined, async () => charges.payQrCharge(await payTokenOf(chargeId), walletId));

/** El cliente abrió el pago con tarjeta en el banco (Redsys): AUTHORIZING con su pedido. */
async function atTheBank(paymentId: string, order: string, amountCents: number, provider: 'REDSYS' | 'PAYTEF' = 'REDSYS') {
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider, providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId, tenantId: V, provider, providerTxId: order, amountCents, tipCents: 0 },
    });
  });
}
const approveCard = (paymentId: string, order: string, provider: 'REDSYS' | 'PAYTEF' = 'REDSYS') =>
  inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider, providerTxId: order }));

function signedRedsys(order: string, amount: string, paymentId: string): string {
  const fields = { Ds_Order: order, Ds_MerchantCode: MERCHANT, Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: amount, Ds_Currency: '978' };
  const s = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: order, ...fields } as never);
  return `Ds_SignatureVersion=${s.Ds_SignatureVersion}&Ds_MerchantParameters=${encodeURIComponent(s.Ds_MerchantParameters)}&Ds_Signature=${encodeURIComponent(s.Ds_Signature)}&_paymentId=${paymentId}`;
}

async function deliver(provider: 'REDSYS' | 'PAYTEF', body: string): Promise<string> {
  const d = await prisma.webhookDelivery.create({
    data: { provider, tenantId: V, externalEventId: `ev-${randomUUID()}`, rawBody: Buffer.from(body), signature: 'x' },
  });
  await ingest.process({ data: { deliveryId: d.id.toString() } } as Job<{ deliveryId: string }>);
  return d.id.toString();
}

async function state(paymentId: string, chargeId: string, walletId?: string) {
  return sys(async (tx) => ({
    payment: await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, ref: true } }),
    charge: await tx.walletChargeRequest.findUniqueOrThrow({
      where: { id: chargeId },
      select: { status: true, ref: true, walletId: true, consumptionId: true, amountCents: true },
    }),
    cardLines: await tx.paymentLine.count({ where: { paymentId } }),
    saldoLines: await tx.paymentLine.count({ where: { walletChargeId: chargeId } }),
    balance: walletId ? (await tx.clientWallet.findUniqueOrThrow({ where: { id: walletId } })).balanceCents : null,
    consumptions: walletId ? await tx.walletConsumption.count({ where: { walletId } }) : null,
    events: (await tx.paymentEvent.findMany({ where: { paymentId }, select: { eventType: true } })).map((e) => e.eventType),
  }));
}

const qrOf = (userId: string) =>
  `https://operator.local/?invita=${signStaffToken({ userId, tenantId: V }, Date.now(), process.env.JWT_SECRET!).token}`;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Medianoche', slug: `cu-${r}`, walletGroup: `gcu-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `CU-${r}`, label: 'Barra', zone: 'BARRA' } });
    // Redsys: la propina que pide el cliente al personal también va en la tarjeta.
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    carlos = (
      await tx.user.create({ data: { tenantId: V, email: `carlos-cu-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Carlos' } })
    ).id;
    nerea = (
      await tx.user.create({
        data: { tenantId: V, email: `nerea-cu-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Nerea' },
      })
    ).id;
    copa = (await tx.serviceItem.create({ data: { tenantId: V, name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' } })).id;
    invita = (
      await tx.serviceItem.create({
        data: { tenantId: V, name: 'Invitar a una copa', priceCents: 2000, category: 'VENUE_BAR', isInvitation: true },
      })
    ).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('un cobro, dos formas de pagar', () => {
  it('se crea uno solo: misma referencia y mismo importe, las líneas en el cobro con tarjeta', async () => {
    const c = await cobro([{ serviceItemId: copa, qty: 2 }]);
    expect(c.saldo?.chargeId).toBeTruthy();
    expect(c.amountCents).toBe(2000);
    const s = await state(c.id, c.saldo!.chargeId);
    expect(s.charge).toMatchObject({ status: 'PENDING', amountCents: 2000, walletId: null });
    expect(s.charge.ref).toBe(s.payment.ref);
    expect(c.ref).toMatch(/^C-\d{4}$/);
    expect([s.cardLines, s.saldoLines]).toEqual([1, 0]);
  });

  it('las apps antiguas (sin withSaldo): solo tarjeta, como siempre', async () => {
    const c = await cobro([{ serviceItemId: copa }], { withSaldo: undefined });
    expect(c.saldo).toBeNull();
    expect(await sys((tx) => tx.walletChargeRequest.count({ where: { linkedPaymentId: c.id } }))).toBe(0);
  });

  it('con el saldo apagado en el local: solo tarjeta (no falla)', async () => {
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { paymentMethods: { wallet: false } } }));
    try {
      const c = await cobro([{ serviceItemId: copa }]);
      expect(c.saldo).toBeNull();
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { paymentMethods: {} } }));
    }
  });
});

describe('gana el saldo: el cobro con tarjeta se cancela', () => {
  it('NFC sin PIN: PAGADO del saldo, líneas al saldo, la tarjeta ya no se autoriza', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const paid = await payNfc(c.saldo!.chargeId, w);
    expect(paid).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4000, ref: c.ref });
    const s = await state(c.id, c.saldo!.chargeId, w.id);
    expect(s.payment.status).toBe('CANCELED');
    expect(s.charge.status).toBe('ACCEPTED');
    expect([s.cardLines, s.saldoLines]).toEqual([0, 1]);
    expect(s.events).toContain('payment.paid_with_saldo');
    // La página del cliente ya no lo cobra con tarjeta: «Ya está pagado con tu saldo».
    expect(await inVenue(undefined, () => payments.getPayPage(c.qrToken))).toEqual({ kind: 'closed', reason: 'paid-with-saldo' });
    await expect(approveCard(c.id, `LATE${r}`)).rejects.toBeInstanceOf(InvalidTransitionError);
    // Y cómo pagó, para el PAGADO de quien cobra.
    const view = await inVenue(V, () => charges.getRequest(carlosActor(), c.saldo!.chargeId));
    expect(view.paidWith).toBe('nfc_nopin');
  });

  it('con el cliente en la página del banco (AUTHORIZING): paga el saldo; la aprobación tardía de Redsys queda como «cobrado dos veces»', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const order = `RL${r}`;
    await atTheBank(c.id, order, 1000);
    await payNfc(c.saldo!.chargeId, w);
    expect((await state(c.id, c.saldo!.chargeId)).payment.status).toBe('CANCELED');

    // El aviso firmado de Redsys llega después: no se da por pagado y Redsys
    // no devuelve por API → incidencia clara, aviso cerrado (no se reintenta).
    const deliveryId = await deliver('REDSYS', signedRedsys(order, '1000', c.id));
    const s = await state(c.id, c.saldo!.chargeId, w.id);
    expect(s.payment.status).toBe('CANCELED');
    expect(s.balance).toBe(4000);
    expect((await prisma.webhookDelivery.findUnique({ where: { id: BigInt(deliveryId) } }))?.processedAt).not.toBeNull();
    const unbooked = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: c.id, eventType: 'payment.approval_unbooked' } }));
    expect(unbooked).toHaveLength(1);
    expect(unbooked[0]!.payload).toMatchObject({ reason: 'paid_with_saldo', providerTxId: order, amountCents: 1000 });
    const inbox = await inVenue(V, () => incidents.list(V));
    const twice = inbox.find((i) => i.kind === 'approval_unbooked' && i.paymentId === c.id);
    expect(twice?.title).toMatch(/dos veces/);
    expect(twice?.detail).toContain(order);
    expect(twice?.amountCents).toBe(1000);

    // La conciliación no lo apunta otra vez.
    await reconcile.process({ data: { paymentId: c.id, tenantId: V }, attemptsMade: 0, opts: { attempts: 1 } } as never);
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId: c.id, eventType: 'payment.approval_unbooked' } }))).toBe(1);
  });

  it('pagado con Face ID desde /s: la respuesta trae el código del cobro con tarjeta (el mismo que ve el personal)', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const paid = await payFaceId(c.saldo!.chargeId, w.id);
    expect(paid.code).toBe(confirmationCode(c.id));
  });

  it('si la pasarela devuelve por API, la tarjeta tardía se devuelve sola (sin incidencia, una sola vez)', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const order = `PT${r}`;
    await atTheBank(c.id, order, 1000, 'PAYTEF');
    await payFaceId(c.saldo!.chargeId, w.id);
    await deliver('PAYTEF', `order=${order}&_paymentId=${c.id}`);
    await deliver('PAYTEF', `order=${order}&_paymentId=${c.id}`);
    // Aviso perdido y conciliación: tampoco devuelve otra vez.
    await reconcile.process({ data: { paymentId: c.id, tenantId: V }, attemptsMade: 0, opts: { attempts: 1 } } as never);
    const done = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: c.id, eventType: 'payment.card_refunded_after_saldo' } }));
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ providerTxId: order, amountCents: 1000, providerRefundId: `RF-saldo-${order}` });
    expect(refunds.filter((x) => x.reference === `saldo-${order}`)).toHaveLength(1);
    const inbox = await inVenue(V, () => incidents.list(V));
    expect(inbox.some((i) => i.kind === 'approval_unbooked' && i.paymentId === c.id)).toBe(false);
  });
});

describe('gana la tarjeta: el saldo se cancela', () => {
  it('el NFC acercado después contesta «Ya está pagado» y no toca el saldo', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const order = `CW${r}`;
    await atTheBank(c.id, order, 1000);
    await approveCard(c.id, order);
    let s = await state(c.id, c.saldo!.chargeId, w.id);
    expect(s.payment.status).toBe('AUTHORIZED');
    expect(s.charge.status).toBe('CANCELED');

    const err = await payNfc(c.saldo!.chargeId, w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: ALREADY_PAID_CODE });
    // Con el PIN o con Face ID, lo mismo.
    await expect(
      inVenue(V, () => charges.payQrChargeWithPin(carlosActor(), c.saldo!.chargeId, { card: w.card, uid: w.uid, pin: '4827' })),
    ).rejects.toMatchObject({ response: { code: ALREADY_PAID_CODE } });
    await expect(payFaceId(c.saldo!.chargeId, w.id)).rejects.toMatchObject({ response: { code: ALREADY_PAID_CODE } });

    s = await state(c.id, c.saldo!.chargeId, w.id);
    expect(s.balance).toBe(5000);
    expect(s.consumptions).toBe(0);
    expect([s.cardLines, s.saldoLines]).toEqual([1, 0]);
    // La página del saldo (/s) y quien cobra lo saben.
    const client = await inVenue(undefined, async () => charges.qrChargeForClient(await payTokenOf(c.saldo!.chargeId)));
    expect(client).toMatchObject({ status: 'CANCELED', paidElsewhere: true });
    const view = await inVenue(V, () => charges.getRequest(carlosActor(), c.saldo!.chargeId));
    expect(view).toMatchObject({ status: 'CANCELED', paidElsewhere: true });
  });

  it('cancelar el cobro cancela también el del saldo', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    await inVenue(V, () => payments.cancel(c.id, { userId: carlos, role: 'WAITER', tenantId: V }));
    expect((await state(c.id, c.saldo!.chargeId)).charge.status).toBe('CANCELED');
    await expect(payNfc(c.saldo!.chargeId, w)).rejects.toMatchObject({ response: { code: 'CHARGE_NOT_PENDING' } });
  });
});

describe('las carreras: nunca se cobra dos veces (Postgres real)', () => {
  it('la aprobación del banco y el NFC a la vez: gana uno solo, varias rondas', async () => {
    const winners: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const w = await wallet(5000);
      const c = await cobro([{ serviceItemId: copa }]);
      const order = `RN${r}${round}`;
      await atTheBank(c.id, order, 1000);
      // Unas rondas sale antes el aviso del banco y otras el NFC.
      const [card, nfc] =
        round % 2 === 0
          ? await Promise.allSettled([approveCard(c.id, order), payNfc(c.saldo!.chargeId, w)])
          : await Promise.allSettled([payNfc(c.saldo!.chargeId, w), approveCard(c.id, order)]).then(([a, b]) => [b, a] as const);
      const s = await state(c.id, c.saldo!.chargeId, w.id);
      const cardWon = s.payment.status === 'AUTHORIZED';
      const saldoWon = s.charge.status === 'ACCEPTED';
      expect(cardWon !== saldoWon).toBe(true);
      winners.push(cardWon ? 'tarjeta' : 'saldo');
      if (cardWon) {
        expect(s.charge.status).toBe('CANCELED');
        expect(s.balance).toBe(5000);
        expect(s.consumptions).toBe(0);
        expect([s.cardLines, s.saldoLines]).toEqual([1, 0]);
      } else {
        expect(s.payment.status).toBe('CANCELED');
        expect(s.balance).toBe(4000);
        expect(s.consumptions).toBe(1);
        expect([s.cardLines, s.saldoLines]).toEqual([0, 1]);
      }
      // El perdedor falla con un error de negocio, nunca a medias.
      const lost = [card, nfc].filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason instanceof InvalidTransitionError || lost[0]!.reason instanceof ConflictException).toBe(true);
    }
    expect(winners).toHaveLength(6);
  });

  it('Face ID del cliente y la tarjeta a la vez (cobro recién creado): gana uno solo', async () => {
    for (let round = 0; round < 4; round += 1) {
      const w = await wallet(5000);
      const c = await cobro([{ serviceItemId: copa }]);
      const order = `RF${r}${round}`;
      await atTheBank(c.id, order, 1000);
      await Promise.allSettled([payFaceId(c.saldo!.chargeId, w.id), approveCard(c.id, order)]);
      const s = await state(c.id, c.saldo!.chargeId, w.id);
      expect((s.payment.status === 'AUTHORIZED') !== (s.charge.status === 'ACCEPTED')).toBe(true);
      expect(s.cardLines + s.saldoLines).toBe(1);
      expect(s.balance).toBe(s.charge.status === 'ACCEPTED' ? 4000 : 5000);
    }
  });
});

describe('la propina la elige el cliente al pagar (B1)', () => {
  const STAFF_TIP_REMOVED = { response: expect.objectContaining({ code: 'STAFF_TIP_REMOVED' }) };
  const TIP_NOT_VALID = { response: expect.objectContaining({ code: 'TIP_NOT_VALID' }) };
  const consumptionOf = (chargeId: string) =>
    sys((tx) => tx.walletConsumption.findFirst({ where: { idempotencyKey: `charge-request:${chargeId}` } }));
  const balanceOf = async (walletId: string) =>
    (await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId } }))).balanceCents;

  it('el personal ya no la pone: el cobro único y el del saldo con propina, 400 sin crear nada', async () => {
    const before = await sys((tx) => tx.walletChargeRequest.count({ where: { tenantId: V } }));
    await expect(cobro([{ serviceItemId: copa }], { tipCents: 500 })).rejects.toMatchObject(STAFF_TIP_REMOVED);
    await expect(
      inVenue(V, () => charges.createQrCharge({ userId: nerea, role: 'OPERATOR', tenantId: V }, { amountCents: 1000, tipCents: 200 })),
    ).rejects.toMatchObject(STAFF_TIP_REMOVED);
    expect(await sys((tx) => tx.walletChargeRequest.count({ where: { tenantId: V } }))).toBe(before);
  });

  it('con su PIN la elige el cliente (del local si cobra el camarero); en la tarjeta, nada marcado', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    expect(c.amountCents).toBe(1000);
    const page = await inVenue(undefined, () => payments.getPayPage(c.qrToken));
    expect(page).toMatchObject({ kind: 'choose', amountCents: 1000 });
    expect(page).not.toHaveProperty('presetTipCents');
    const paid = await inVenue(V, () =>
      charges.payQrChargeWithPin(carlosActor(), c.saldo!.chargeId, { card: w.card, uid: w.uid, pin: '4827', tipCents: 500 }),
    );
    expect(paid).toMatchObject({ status: 'ACCEPTED', amountCents: 1000, tipCents: 500, newBalanceCents: 3500 });
    expect(await consumptionOf(c.saldo!.chargeId)).toMatchObject({ amountCents: 1000, tipCents: 500, tipGoesTo: 'venue' });
  });

  it('con su Face ID en /s, al cobrar la chica: la propina es entera para ella', async () => {
    const w = await wallet(20_000);
    const servicio = await sys((tx) =>
      tx.serviceItem.create({ data: { tenantId: V, name: '1 h', priceCents: 12_000, category: 'CHICA_SERVICE' } }),
    );
    const qr = await inVenue(V, () =>
      charges.createQrCharge({ userId: nerea, role: 'OPERATOR', tenantId: V }, { serviceItemId: servicio.id }),
    );
    const view = await inVenue(undefined, () => charges.qrChargeForClient(qr.payToken));
    expect(view.tip).toMatchObject({ baseCents: 12_000, previousCents: 0, maxCents: 12_000, toStaff: true });
    const paid = await inVenue(undefined, () => charges.payQrCharge(qr.payToken, w.id, 1000));
    expect(paid).toMatchObject({ amountCents: 13_000, balanceCents: 7000 });
    const consumption = await consumptionOf(qr.id);
    expect(consumption).toMatchObject({ amountCents: 12_000, tipCents: 1000, tipGoesTo: 'operator' });
    const earning = await sys((tx) => tx.operatorEarning.findFirst({ where: { consumptionId: consumption!.id } }));
    expect(earning).toMatchObject({ operatorId: nerea, commissionCents: 10_800, tipCents: 1000 });
    // El personal la ve en su PAGADO: queda en el cobro.
    expect(await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: qr.id } }))).toMatchObject({ tipCents: 1000 });
  });

  it('más que el importe: 400 y no se cobra nada (el cobro sigue libre)', async () => {
    const w = await wallet(5000);
    const qr = await inVenue(V, () => charges.createQrCharge({ userId: nerea, role: 'OPERATOR', tenantId: V }, { amountCents: 1000 }));
    await expect(inVenue(undefined, () => charges.payQrCharge(qr.payToken, w.id, 2000))).rejects.toMatchObject(TIP_NOT_VALID);
    expect(await balanceOf(w.id)).toBe(5000);
    expect(await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: qr.id } }))).toMatchObject({
      status: 'PENDING',
      walletId: null,
      tipCents: 0,
    });
    // «Sin propina» sí.
    await inVenue(undefined, () => charges.payQrCharge(qr.payToken, w.id, 0));
    expect(await balanceOf(w.id)).toBe(4000);
  });

  it('un cobro de antes con la propina del personal: con su PIN se respeta si no elige, y la puede quitar (sin PIN, no)', async () => {
    const legacy = async () => {
      const c = await cobro([{ serviceItemId: copa }]);
      await sys((tx) => tx.walletChargeRequest.update({ where: { id: c.saldo!.chargeId }, data: { tipCents: 300 } }));
      return c;
    };
    const kept = await legacy();
    const w1 = await wallet(5000);
    // Con propina, la ficha siempre pide el PIN (decisión del dueño, 17-nov): la confirma el cliente.
    await expect(payNfc(kept.saldo!.chargeId, w1)).rejects.toMatchObject({ reason: 'tip' });
    await expect(
      inVenue(V, () => charges.payQrChargeWithPin(carlosActor(), kept.saldo!.chargeId, { card: w1.card, uid: w1.uid, pin: '4827' })),
    ).resolves.toMatchObject({ status: 'ACCEPTED', tipCents: 300, newBalanceCents: 3700 });
    const removed = await legacy();
    const w2 = await wallet(5000);
    const paid = await inVenue(V, () =>
      charges.payQrChargeWithPin(carlosActor(), removed.saldo!.chargeId, { card: w2.card, uid: w2.uid, pin: '4827', tipCents: 0 }),
    );
    expect(paid).toMatchObject({ status: 'ACCEPTED', tipCents: 0, newBalanceCents: 4000 });
  });

  it('con las propinas apagadas en el local, solo «Sin propina»', async () => {
    const methods = await sys((tx) => tx.venue.findUniqueOrThrow({ where: { id: V }, select: { paymentMethods: true } }));
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { paymentMethods: { ...(methods.paymentMethods as object), tips: false } } }));
    try {
      const w = await wallet(5000);
      const qr = await inVenue(V, () => charges.createQrCharge({ userId: nerea, role: 'OPERATOR', tenantId: V }, { amountCents: 1000 }));
      expect((await inVenue(undefined, () => charges.qrChargeForClient(qr.payToken))).tip).toBeUndefined();
      await expect(inVenue(undefined, () => charges.payQrCharge(qr.payToken, w.id, 200))).rejects.toMatchObject(TIP_NOT_VALID);
      await inVenue(undefined, () => charges.payQrCharge(qr.payToken, w.id, 0));
      expect(await balanceOf(w.id)).toBe(4000);
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { paymentMethods: methods.paymentMethods ?? undefined } }));
    }
  });
});

describe('la página de pago del QR', () => {
  it('ofrece «Pagar con mi saldo OxioCard» con el enlace del mismo cobro', async () => {
    const c = await cobro([{ serviceItemId: copa }]);
    const view = await inVenue(undefined, () => payments.getPayPage(c.qrToken));
    expect(view).toMatchObject({ kind: 'choose', amountCents: 1000, saldoPayToken: await payTokenOf(c.saldo!.chargeId) });
    const old = await cobro([{ serviceItemId: copa }], { withSaldo: undefined });
    const plain = await inVenue(undefined, () => payments.getPayPage(old.qrToken));
    expect(plain).toMatchObject({ kind: 'choose' });
    expect((plain as { saldoPayToken?: string }).saldoPayToken).toBeUndefined();
  });
});

describe('invitar a una copa: el reparto y «Mi noche» de la chica', () => {
  it('pagada con NFC la invitación: Nerea se lleva su parte y su noche cuenta solo su parte', async () => {
    const w = await wallet(10_000);
    const before = await inVenue(V, () => nights.mine(V, nerea));
    // Con el saldo (NFC) y con tarjeta, una de cada.
    const bySaldo = await cobro([{ serviceItemId: invita }], { invitedStaffToken: qrOf(nerea) });
    expect(bySaldo.amountCents).toBe(2000);
    await payNfc(bySaldo.saldo!.chargeId, w);
    const byCard = await cobro([{ serviceItemId: invita }], { invitedStaffToken: qrOf(nerea) });
    const order = `IN${r}`;
    await atTheBank(byCard.id, order, 2000);
    await approveCard(byCard.id, order);

    const consumption = await sys((tx) =>
      tx.walletConsumption.findFirst({ where: { idempotencyKey: `charge-request:${bySaldo.saldo!.chargeId}` } }),
    );
    const shares = await sys((tx) =>
      tx.operatorEarning.findMany({
        where: { operatorId: nerea, OR: [{ consumptionId: consumption!.id }, { paymentId: byCard.id }] },
      }),
    );
    expect(shares.map((e) => e.commissionCents).sort()).toEqual([1000, 1000]);

    const after = await inVenue(V, () => nights.mine(V, nerea));
    // Antes contaba el cobro entero (20 € cada una); ahora, solo su parte.
    expect(after.chargedCents - before.chargedCents).toBe(2000);
    expect(after.commissionCents - before.commissionCents).toBe(2000);
    expect(after.count - before.count).toBe(2);
    expect(after.invitations.count - before.invitations.count).toBe(2);
    expect(after.invitations.shareCents - before.invitations.shareCents).toBe(2000);
  });
});

describe('invitar eligiendo a la chica de la lista (Ajustes → Invitaciones)', () => {
  it('con el QR obligatorio (de fábrica) no se puede; si el local no lo pide, sí, con su reparto', async () => {
    await expect(cobro([{ serviceItemId: invita }], { invitedOperatorId: nerea })).rejects.toThrow(/pide el QR/);
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { invitationRules: { requireQr: false } } }));
    try {
      const c = await cobro([{ serviceItemId: invita }], { invitedOperatorId: nerea });
      const line = await sys((tx) => tx.paymentLine.findFirst({ where: { paymentId: c.id } }));
      expect(line).toMatchObject({ beneficiaryOperatorId: nerea, beneficiaryCents: 1000 });
      // A quien no es chica del local, no.
      await expect(cobro([{ serviceItemId: invita }], { invitedOperatorId: carlos })).rejects.toThrow(/no vale/);
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { invitationRules: {} } }));
    }
  });
});

describe('la lista de Cobros: una fila por cobro (Hoy → Cobros, la ficha y «Mis cobros»)', () => {
  const cobros = new CobrosService(prisma as never);
  const periods = new PeriodReportsService(prisma as never);
  const since = new Date(Date.now() - 60_000).toISOString();
  const rowsOf = async (ref: string | null, q: Record<string, unknown> = {}) => {
    const page = await inVenue(V, () => cobros.list(V, CobrosQuerySchema.parse({ limit: 200, from: since, ...q })));
    return page.items.filter((x) => x.ref === ref);
  };
  const kinds = (rows: Array<{ kind: string; status: string }>) => rows.map((x) => `${x.kind} ${x.status}`).sort();

  it('pagado con la ficha: una sola fila, la del saldo «Pagado»; también por chica, sección, tarjeta y estado', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    await payNfc(c.saldo!.chargeId, w);
    const rows = await rowsOf(c.ref);
    expect(kinds(rows)).toEqual(['SALDO ACCEPTED']);
    expect(rows[0]!.paidTwice ?? null).toBeNull();
    expect(kinds(await rowsOf(c.ref, { operatorId: carlos }))).toEqual(['SALDO ACCEPTED']);
    expect(kinds(await rowsOf(c.ref, { category: 'VENUE_BAR' }))).toEqual(['SALDO ACCEPTED']);
    expect(await rowsOf(c.ref, { method: 'CARD' })).toEqual([]);
    expect(await rowsOf(c.ref, { status: 'CANCELED' })).toEqual([]);
  });

  it('un cobro de dos secciones pagado con el saldo (Face ID) no deja otra fila con todo el importe en su sección principal', async () => {
    const nachos = await sys((tx) =>
      tx.serviceItem.create({ data: { tenantId: V, name: 'Nachos', priceCents: 900, category: 'VENUE_FOOD' } }),
    );
    const w = await wallet(5000);
    // Cocina pesa más (18 €): es la sección principal del cobro.
    const c = await cobro([{ serviceItemId: copa }, { serviceItemId: nachos.id, qty: 2 }]);
    await payFaceId(c.saldo!.chargeId, w.id);
    expect(kinds(await rowsOf(c.ref))).toEqual(['SALDO ACCEPTED']);
    const food = await rowsOf(c.ref, { category: 'VENUE_FOOD' });
    expect(kinds(food)).toEqual(['SALDO ACCEPTED']);
    expect(food[0]!.sections).toEqual([
      { category: 'VENUE_FOOD', amountCents: 1800 },
      { category: 'VENUE_BAR', amountCents: 1000 },
    ]);
  });

  it('cancelado de verdad o pagado con tarjeta: una sola fila, la del cobro con tarjeta', async () => {
    const canceled = await cobro([{ serviceItemId: copa }]);
    await inVenue(V, () => payments.cancel(canceled.id, { userId: carlos, role: 'WAITER', tenantId: V }));
    expect(kinds(await rowsOf(canceled.ref))).toEqual(['PAYMENT CANCELED']);
    const byCard = await cobro([{ serviceItemId: copa }]);
    await atTheBank(byCard.id, `LC${r}`, 1000);
    await approveCard(byCard.id, `LC${r}`);
    expect(kinds(await rowsOf(byCard.ref))).toEqual(['PAYMENT AUTHORIZED']);
  });

  it('cobrado dos veces (el banco aprueba la tarjeta después de la ficha): se ven las dos, la de tarjeta marcada «a devolver»', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const order = `RL2${r}`;
    await atTheBank(c.id, order, 1000);
    await payNfc(c.saldo!.chargeId, w);
    await deliver('REDSYS', signedRedsys(order, '1000', c.id));
    const rows = await rowsOf(c.ref);
    expect(kinds(rows)).toEqual(['PAYMENT CANCELED', 'SALDO ACCEPTED']);
    expect(rows.find((x) => x.kind === 'PAYMENT')!.paidTwice).toEqual({ amountCents: 1000, refunded: false });
    expect(rows.find((x) => x.kind === 'SALDO')!.paidTwice ?? null).toBeNull();
  });

  it('cobrado dos veces y la pasarela lo devolvió sola: se ve, marcada «devuelto solo»', async () => {
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    const order = `PT2${r}`;
    await atTheBank(c.id, order, 1000, 'PAYTEF');
    await payFaceId(c.saldo!.chargeId, w.id);
    await deliver('PAYTEF', `order=${order}&_paymentId=${c.id}`);
    const rows = await rowsOf(c.ref);
    expect(kinds(rows)).toEqual(['PAYMENT CANCELED', 'SALDO ACCEPTED']);
    expect(rows.find((x) => x.kind === 'PAYMENT')!.paidTwice).toEqual({ amountCents: 1000, refunded: true });
  });

  it('los cobros por estado (métricas) no cuentan el cobro con tarjeta que anuló la ficha', async () => {
    const before = (await inVenue(V, () => periods.metrics(V))).statusBreakdown;
    const w = await wallet(5000);
    const c = await cobro([{ serviceItemId: copa }]);
    await payNfc(c.saldo!.chargeId, w);
    const after = (await inVenue(V, () => periods.metrics(V))).statusBreakdown;
    expect(after.CANCELED ?? 0).toBe(before.CANCELED ?? 0);
    expect(after.CREATED ?? 0).toBe(before.CREATED ?? 0);
  });
});
