// Integración (Postgres real): avisos de pasarela, aprobación tras fallo y conciliación de huérfanos. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RedsysAdapter } from '../../src/modules/gateways/redsys.adapter';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { OrphanReconcileProcessor } from '../../src/modules/queues/orphan-reconcile.processor';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  {} as never,
  {} as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop } } as never,
  {} as never,
  {} as never,
  {} as never,
);
const SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const MERCHANT = '999008881';
const config = {
  get: (k: string) =>
    ({
      REDSYS_MERCHANT_CODE: MERCHANT,
      REDSYS_TERMINAL: '1',
      REDSYS_SECRET_KEY: SECRET,
      REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
    })[k],
};
const redsys = new RedsysAdapter(config as never, { gatewayDuration: { observe: noop }, circuitState: { set: noop } } as never);
const peanpeStub = {
  provider: 'PEANPE',
  mapWebhookToFsmEvent: (p: Record<string, unknown>) => ({
    paymentId: String(p._paymentId),
    event: { type: 'AUTHORIZED', providerTxId: String(p.identificador_llamada), provider: 'PEANPE' },
  }),
  proveApproval: async () => ({ kind: 'unverifiable', reason: 'peanpe-sin-consulta' }),
};
const gatewayStatus: Record<string, string> = {};
const redsysForReconcile = { provider: 'REDSYS', getStatus: async (_t: string, o: string) => gatewayStatus[o] ?? 'UNKNOWN' };
const registry = { get: (p: string) => (p === 'PEANPE' ? peanpeStub : redsys) };
const processor = new WebhookIngestProcessor(prisma as never, payments as never, registry as never);
const reconcile = new OrphanReconcileProcessor(prisma as never, payments as never, { get: () => redsysForReconcile } as never);
const incidents = new IncidentsService(prisma as never, { log: async () => undefined } as never);

const r = randomUUID().slice(0, 6);
let A: string, chica: string, term: string;

const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => prisma.asSystem(fn);

async function payment(o: {
  status: string;
  provider: 'REDSYS' | 'PEANPE';
  amount: number;
  order: string;
  walletId?: string;
  attempts?: Array<{ order: string; amount: number; tip: number; status?: string; ago?: number }>;
}): Promise<string> {
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        createdByUserId: chica,
        idempotencyKey: `k-${randomUUID()}`,
        amountCents: o.amount,
        availableAmountCents: o.amount,
        qrToken: `qr-${randomUUID()}`,
        qrExpiresAt: new Date(Date.now() + 3600_000),
        status: o.status as never,
        provider: o.provider,
        providerTxId: o.order,
        revenueCategory: 'CHICA_SERVICE',
        walletId: o.walletId ?? null,
      },
    });
    for (const a of o.attempts ?? []) {
      await tx.paymentAttempt.create({
        data: {
          paymentId: p.id,
          tenantId: A,
          provider: o.provider,
          providerTxId: a.order,
          amountCents: a.amount,
          tipCents: a.tip,
          status: a.status ?? 'PENDING',
          createdAt: new Date(Date.now() - (a.ago ?? 0) * 1000),
        },
      });
    }
    return p.id;
  });
}

function signedRedsys(order: string, amount: string, paymentId: string): string {
  const fields = { Ds_Order: order, Ds_MerchantCode: MERCHANT, Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: amount, Ds_Currency: '978' };
  const s = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: order, ...fields } as never);
  return `Ds_SignatureVersion=${s.Ds_SignatureVersion}&Ds_MerchantParameters=${encodeURIComponent(s.Ds_MerchantParameters)}&Ds_Signature=${encodeURIComponent(s.Ds_Signature)}&_paymentId=${paymentId}`;
}

async function deliver(provider: 'REDSYS' | 'PEANPE', body: string): Promise<string> {
  const d = await prisma.webhookDelivery.create({
    data: { provider, tenantId: A, externalEventId: `ev-${randomUUID()}`, rawBody: Buffer.from(body), signature: 'x' },
  });
  await processor.process({ data: { deliveryId: d.id.toString() } } as Job<{ deliveryId: string }>);
  return d.id.toString();
}

const statusOf = (id: string) => sys((tx) => tx.payment.findUnique({ where: { id } }));
const eventsOf = (id: string, type: string) =>
  sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: id, eventType: type } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Local GW', slug: `gw-${r}` } })).id;
    chica = (await tx.user.create({ data: { tenantId: A, email: `op-gw-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 5000 } })).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TGW-${r}`, label: 'GW' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('FAILED → AUTHORIZED con efectos reales (Postgres)', () => {
  it('aprobación tras FAILED: AUTHORIZED, hora de pago, propina del intento y comisión de la chica', async () => {
    const id = await payment({
      status: 'FAILED',
      provider: 'REDSYS',
      amount: 4000,
      order: 'F1',
      attempts: [{ order: `F1${r}`, amount: 4500, tip: 500 }],
    });
    await payments.transition(id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `F1${r}` });
    const p = await statusOf(id);
    expect(p?.status).toBe('AUTHORIZED');
    expect(p?.authorizedAt).not.toBeNull();
    expect(p?.tipCents).toBe(500);
    expect(p?.availableAmountCents).toBe(4500);
    const earning = await sys((tx) => tx.operatorEarning.findFirst({ where: { paymentId: id } }));
    expect(earning).toMatchObject({ operatorId: chica, commissionCents: 2000, tipCents: 500 });
  });

  it('recarga de saldo FAILED que el banco aprobó: el saldo se acredita', async () => {
    const wallet = await sys((tx) =>
      tx.clientWallet.create({ data: { tenantId: A, balanceCents: 0, status: 'ACTIVE', qrToken: `wq-gw-${r}` } }),
    );
    const id = await payment({ status: 'FAILED', provider: 'REDSYS', amount: 3000, order: `W1${r}`, walletId: wallet.id });
    await payments.transition(id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `W1${r}` });
    const w = await sys((tx) => tx.clientWallet.findUnique({ where: { id: wallet.id } }));
    expect(w?.balanceCents).toBe(3000);
  });
});

describe('procesador de avisos contra Postgres real', () => {
  it('aviso Redsys firmado con importe distinto → no se paga; incidencia en la bandeja', async () => {
    const order = `M1${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 4850, order, attempts: [{ order, amount: 4850, tip: 0 }] });
    const deliveryId = await deliver('REDSYS', signedRedsys(order, '100', id));
    expect((await statusOf(id))?.status).toBe('AUTHORIZING');
    const ev = await eventsOf(id, 'payment.amount_mismatch');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ chargedCents: 100, expectedCents: 4850, deliveryId });
    const d = await prisma.webhookDelivery.findUnique({ where: { id: BigInt(deliveryId) } });
    expect(d?.processedAt).not.toBeNull();
    const list = await incidents.list(A);
    expect(list.find((i) => i.kind === 'amount_mismatch' && i.paymentId === id)?.detail).toContain('Aprobado 1,00 €');
  });

  it('aviso Redsys firmado con el importe del intento (con propina) → AUTHORIZED', async () => {
    const order = `OK${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 4000, order, attempts: [{ order, amount: 5000, tip: 1000 }] });
    await deliver('REDSYS', signedRedsys(order, '5000', id));
    const p = await statusOf(id);
    expect(p?.status).toBe('AUTHORIZED');
    expect(p?.tipCents).toBe(1000);
  });

  it('aprobación para un cobro caducado → incidencia "no se pudo apuntar", aviso cerrado', async () => {
    const order = `EX${r}`;
    const id = await payment({ status: 'EXPIRED', provider: 'REDSYS', amount: 2500, order, attempts: [{ order, amount: 2500, tip: 0 }] });
    await deliver('REDSYS', signedRedsys(order, '2500', id));
    expect((await statusOf(id))?.status).toBe('EXPIRED');
    expect(await eventsOf(id, 'payment.approval_unbooked')).toHaveLength(1);
    expect((await incidents.list(A)).some((i) => i.kind === 'approval_unbooked' && i.paymentId === id)).toBe(true);
  });

  it('Peanpe "pagado" → no se paga; incidencia sin comprobar que se va al resolver el cobro', async () => {
    const id = await payment({ status: 'AUTHORIZING', provider: 'PEANPE', amount: 2000, order: `PE${r.slice(0, 4)}` });
    await deliver('PEANPE', JSON.stringify({ identificador_llamada: `PE${r.slice(0, 4)}`, status: '200', _paymentId: id }));
    expect((await statusOf(id))?.status).toBe('AUTHORIZING');
    expect((await incidents.list(A)).some((i) => i.kind === 'approval_unverified' && i.refId === id)).toBe(true);
    // El dueño lo resuelve (aquí: no estaba cobrado) → la incidencia desaparece sola.
    await payments.transition(id, { type: 'FAILED', reason: 'manual' });
    expect((await incidents.list(A)).some((i) => i.kind === 'approval_unverified' && i.refId === id)).toBe(false);
  });
});

describe('conciliación de huérfanos contra Postgres real (#6)', () => {
  it('intento 1 aprobado (aviso perdido) + intento 2 denegado → AUTHORIZED con el pedido y la propina del 1', async () => {
    const o1 = `R1${r}`;
    const o2 = `R2${r}`;
    gatewayStatus[o1] = 'AUTHORIZED';
    gatewayStatus[o2] = 'FAILED';
    const id = await payment({
      status: 'AUTHORIZING',
      provider: 'REDSYS',
      amount: 4000,
      order: o2,
      attempts: [
        { order: o1, amount: 4000, tip: 0, ago: 120 },
        { order: o2, amount: 5000, tip: 1000, status: 'DENIED' },
      ],
    });
    await reconcile.process({ data: { paymentId: id, tenantId: A }, attemptsMade: 0, opts: { attempts: 5 } } as never);
    const p = await statusOf(id);
    expect(p?.status).toBe('AUTHORIZED');
    expect(p?.providerTxId).toBe(o1);
    expect(p?.tipCents).toBe(0);
    const att = await sys((tx) => tx.paymentAttempt.findMany({ where: { paymentId: id }, orderBy: { createdAt: 'asc' } }));
    expect(att.map((a) => a.status)).toEqual(['APPROVED', 'DENIED']);
  });

  it('todo denegado y reintentos agotados → ORPHAN (nunca FAILED)', async () => {
    const o = `R3${r}`;
    gatewayStatus[o] = 'FAILED';
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 1000, order: o, attempts: [{ order: o, amount: 1000, tip: 0 }] });
    await reconcile.process({ data: { paymentId: id, tenantId: A }, attemptsMade: 4, opts: { attempts: 5 } } as never);
    expect((await statusOf(id))?.status).toBe('ORPHAN');
  });
});
