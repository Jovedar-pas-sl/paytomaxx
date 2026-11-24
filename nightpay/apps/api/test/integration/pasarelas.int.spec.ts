// Integración (Postgres real): avisos de pasarela, aprobación tras fallo y conciliación de huérfanos. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { WebhooksController } from '../../src/modules/webhooks/webhooks.controller';
import { RedsysReturnService } from '../../src/modules/payments/redsys-return.service';
import type { FastifyRequest } from 'fastify';

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
  { paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop }, duplicateCharges: { inc: noop } } as never,
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
/** Paytef como el de verdad (FSD-02): el aviso nombra el intento (clientID) y la prueba exige que sea el de ese pedido. */
const paytefStub = {
  provider: 'PAYTEF',
  mapWebhookToFsmEvent: (p: Record<string, unknown>) => {
    const data = p.data as { id: string; clientID: string };
    return { paymentId: data.clientID, event: { type: 'AUTHORIZED', providerTxId: data.id, provider: 'PAYTEF' } };
  },
  proveApproval: async (claim: { attemptId?: string; payload: Record<string, unknown> }) =>
    claim.attemptId === (claim.payload.data as { clientID: string }).clientID
      ? { kind: 'confirmed', amountCents: 3200, currency: 'EUR' }
      : { kind: 'rejected', reason: 'paytef-link-de-otro-cobro' },
};
const gatewayStatus: Record<string, string> = {};
const redsysForReconcile = { provider: 'REDSYS', getStatus: async (_t: string, o: string) => gatewayStatus[o] ?? 'UNKNOWN' };
const registry = { get: (p: string) => (p === 'PEANPE' ? peanpeStub : p === 'PAYTEF' ? paytefStub : redsys) };
const processor = new WebhookIngestProcessor(prisma as never, payments as never, registry as never);
const reconcile = new OrphanReconcileProcessor(prisma as never, payments as never, { get: () => redsysForReconcile } as never);
const incidents = new IncidentsService(prisma as never, { log: async () => undefined } as never);

const r = randomUUID().slice(0, 6);
let A: string, chica: string, term: string;

const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => prisma.asSystem(fn);

async function payment(o: {
  status: string;
  provider: 'REDSYS' | 'PEANPE' | 'PAYTEF';
  amount: number;
  order: string;
  walletId?: string;
  fee?: number;
  attempts?: Array<{ id?: string; order: string; amount: number; tip: number; status?: string; ago?: number }>;
}): Promise<string> {
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        createdByUserId: chica,
        idempotencyKey: `k-${randomUUID()}`,
        amountCents: o.amount,
        serviceFeeCents: o.fee ?? 0,
        serviceFeeBps: o.fee ? 1000 : null,
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
          ...(a.id ? { id: a.id } : {}),
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

function signedRedsys(order: string, amount: string, paymentId: string, extra: Record<string, string> = {}): string {
  const fields = { Ds_Order: order, Ds_MerchantCode: MERCHANT, Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: amount, Ds_Currency: '978', ...extra };
  const s = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: order, ...fields } as never);
  return `Ds_SignatureVersion=${s.Ds_SignatureVersion}&Ds_MerchantParameters=${encodeURIComponent(s.Ds_MerchantParameters)}&Ds_Signature=${encodeURIComponent(s.Ds_Signature)}&_paymentId=${paymentId}`;
}

async function deliver(provider: 'REDSYS' | 'PEANPE' | 'PAYTEF', body: string): Promise<string> {
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

  it('aviso de Paytef que nombra el intento (clientID, FSD-02) → su cobro AUTHORIZED; el de otro intento, no', async () => {
    const attemptId = randomUUID();
    const link = `PL-${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'PAYTEF', amount: 3200, order: link, attempts: [{ id: attemptId, order: link, amount: 3200, tip: 0 }] });
    const otherLink = `PL2-${r}`;
    const other = await payment({ status: 'AUTHORIZING', provider: 'PAYTEF', amount: 3200, order: otherLink, attempts: [{ order: otherLink, amount: 3200, tip: 0 }] });
    // Un aviso con el clientID de este intento pero el enlace del otro cobro no paga nada.
    await deliver('PAYTEF', JSON.stringify({ paymentID: otherLink, data: { id: otherLink, clientID: attemptId, lastResult: { isApproved: true } } }));
    expect((await statusOf(id))?.status).toBe('AUTHORIZING');
    expect((await statusOf(other))?.status).toBe('AUTHORIZING');
    await deliver('PAYTEF', JSON.stringify({ paymentID: link, data: { id: link, clientID: attemptId, lastResult: { isApproved: true } } }));
    expect((await statusOf(id))?.status).toBe('AUTHORIZED');
    expect((await statusOf(other))?.status).toBe('AUTHORIZING');
  });

  it('aviso Redsys firmado con el importe del intento (con propina) → AUTHORIZED', async () => {
    const order = `OK${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 4000, order, attempts: [{ order, amount: 5000, tip: 1000 }] });
    await deliver('REDSYS', signedRedsys(order, '5000', id));
    const p = await statusOf(id);
    expect(p?.status).toBe('AUTHORIZED');
    expect(p?.tipCents).toBe(1000);
  });

  it('aviso Redsys aprobado → pagado con la tarjeta y la autorización en la misma transacción; un segundo cargo no los pisa (punto 70 de la revisión del 20-11)', async () => {
    const order = `TJ${r}`;
    const other = `TK${r}`;
    const id = await payment({
      status: 'AUTHORIZING',
      provider: 'REDSYS',
      amount: 6000,
      order: other,
      attempts: [{ order, amount: 6000, tip: 0 }, { order: other, amount: 6000, tip: 0 }],
    });
    const card = (last4: string, auth: string) => ({
      Ds_Card_Number: `454881******${last4}`,
      Ds_Card_Brand: '1',
      Ds_Card_Type: 'D',
      Ds_Card_Country: '724',
      Ds_AuthorisationCode: auth,
      Ds_SecurePayment: '1',
      Ds_ProcessedPayMethod: '78',
    });
    // Directo al procesador: sin la anotación de la tarjeta del controlador (aparte, y en el pico puede fallar).
    await deliver('REDSYS', signedRedsys(order, '6000', id, card('0003', '123456')));
    expect(await statusOf(id)).toMatchObject({
      status: 'AUTHORIZED',
      providerTxId: order,
      cardLast4: '0003',
      authCode: '123456',
      cardBrand: '1',
      cardType: 'D',
      cardCountry: '724',
      secure3ds: true,
      payMethodCode: '78',
    });
    // El cliente pagó también el otro pedido del mismo cobro: doble cobro apuntado y la tarjeta del primero se queda.
    await deliver('REDSYS', signedRedsys(other, '6000', id, card('0004', '654321')));
    expect(await statusOf(id)).toMatchObject({ status: 'AUTHORIZED', providerTxId: order, cardLast4: '0003', authCode: '123456' });
    expect(await eventsOf(id, 'payment.duplicate_charge')).toHaveLength(1);
  });

  it('avisos del mismo cobro a la vez (la cola procesa hasta 4): se paga una sola vez, con una comisión', async () => {
    for (let round = 0; round < 3; round += 1) {
      const order = `CC${round}${r}`;
      const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 3000, order, attempts: [{ order, amount: 3000, tip: 0 }] });
      const body = Buffer.from(signedRedsys(order, '3000', id));
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const d = await prisma.webhookDelivery.create({
          data: { provider: 'REDSYS', tenantId: A, externalEventId: `ev-${randomUUID()}`, rawBody: body, signature: 'x' },
        });
        ids.push(d.id.toString());
      }
      await Promise.all(ids.map((deliveryId) => processor.process({ data: { deliveryId } } as Job<{ deliveryId: string }>)));
      expect((await statusOf(id))?.status).toBe('AUTHORIZED');
      expect(await eventsOf(id, 'payment.authorized')).toHaveLength(1);
      expect(await eventsOf(id, 'payment.duplicate_charge')).toHaveLength(0);
      expect(await sys((tx) => tx.operatorEarning.count({ where: { paymentId: id } }))).toBe(1);
      const done = await prisma.webhookDelivery.findMany({ where: { id: { in: ids.map((x) => BigInt(x)) } } });
      expect(done.every((d) => d.processedAt !== null)).toBe(true);
    }
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

  it('con la consulta de Redsys de verdad (hoy no disponible: UNKNOWN, sin llamar al banco) → reintenta y acaba «sin confirmar»', async () => {
    const realRedsys = new OrphanReconcileProcessor(prisma as never, payments as never, { get: () => redsys } as never);
    const o = `R4${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 1500, order: o, attempts: [{ order: o, amount: 1500, tip: 0 }] });
    await expect(
      realRedsys.process({ data: { paymentId: id, tenantId: A }, attemptsMade: 0, opts: { attempts: 5 } } as never),
    ).rejects.toThrow('still-pending');
    expect((await statusOf(id))?.status).toBe('AUTHORIZING');
    await realRedsys.process({ data: { paymentId: id, tenantId: A }, attemptsMade: 4, opts: { attempts: 5 } } as never);
    expect((await statusOf(id))?.status).toBe('ORPHAN');
    const att = await sys((tx) => tx.paymentAttempt.findMany({ where: { paymentId: id } }));
    expect(att.map((a) => a.status)).toEqual(['PENDING']);
  });
});

describe('vuelta firmada por el mismo camino que el aviso (Postgres real)', () => {
  function harness() {
    const jobs: string[] = [];
    const queue = {
      getJob: async () => undefined,
      add: async (_name: string, data: { deliveryId: string }) => { jobs.push(data.deliveryId); },
    };
    const metrics = { webhooksReceived: { inc: noop }, duplicateCharges: { inc: noop } };
    const webhooks = new WebhooksController(
      prisma as never, registry as never, queue as never, metrics as never, config as never,
      {} as never, {} as never, {} as never, redsys,
    );
    return { jobs, webhooks, returns: new RedsysReturnService(redsys, webhooks) };
  }

  function bankFields(order: string, amount: number) {
    const values = { Ds_Order: order, Ds_Merchant_Order: order, Ds_MerchantCode: MERCHANT,
      Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: String(amount), Ds_Currency: '978' };
    return serializeAndSignJSONRequest(SECRET, values as never);
  }

  it('confirma una sola vez el total con comisión y propina si llega a la vez que el aviso', async () => {
    const h = harness();
    const order = `RR1${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 3300, fee: 330, order,
      attempts: [{ order, amount: 3830, tip: 200 }] });
    const fields = bankFields(order, 3830);
    const request = { headers: {}, body: fields } as unknown as FastifyRequest;
    await Promise.all([h.returns.process(order, fields), h.webhooks.receiveRedsys(request)]);
    expect(h.jobs.length).toBeGreaterThan(0);
    expect(new Set(h.jobs).size).toBe(1);
    const delivery = await prisma.webhookDelivery.findMany({ where: { provider: 'REDSYS', externalEventId: `${order}-0000` } });
    expect(delivery).toHaveLength(1);
    await processor.process({ data: { deliveryId: h.jobs[0]! } } as Job<{ deliveryId: string }>);
    await h.returns.process(order, fields);
    const p = await statusOf(id);
    expect(p?.status).toBe('AUTHORIZED');
    expect(p?.tipCents).toBe(200);
    expect(p?.serviceFeeCents).toBe(330);
    const earnings = await sys((tx) => tx.operatorEarning.findMany({ where: { paymentId: id } }));
    expect(earnings).toHaveLength(1);
    expect(await prisma.webhookDelivery.count({ where: { provider: 'REDSYS', externalEventId: `${order}-0000` } })).toBe(1);
  });

  it('con la base saturada al buscar el cobro (punto 4 de la revisión del 20-11): el aviso queda guardado y el procesador lo paga', async () => {
    const h = harness();
    const order = `RS1${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 6000, order, attempts: [{ order, amount: 6000, tip: 0 }] });
    // Sábado 01:30, en pleno pico: el pool no da conexión a tiempo (P2028) justo al buscar el cobro.
    const busy = vi.spyOn(prisma, 'asSystem').mockRejectedValueOnce(new Error('P2028 Unable to start a transaction in the given time'));
    try {
      const request = { headers: {}, body: bankFields(order, 6000) } as unknown as FastifyRequest;
      await expect(h.webhooks.receiveRedsys(request)).resolves.toEqual({ received: true });
    } finally {
      busy.mockRestore();
    }
    const saved = await prisma.webhookDelivery.findUnique({
      where: { provider_externalEventId: { provider: 'REDSYS', externalEventId: `${order}-0000` } },
    });
    expect(saved?.processedAt).toBeNull();
    expect(h.jobs).toEqual([saved!.id.toString()]);
    await processor.process({ data: { deliveryId: h.jobs[0]! } } as Job<{ deliveryId: string }>);
    expect((await statusOf(id))?.status).toBe('AUTHORIZED');
    expect((await prisma.webhookDelivery.findUnique({ where: { id: saved!.id } }))?.processedAt).not.toBeNull();
  });

  it('si el importe firmado es distinto, deja incidencia y no marca el pago como cobrado', async () => {
    const h = harness();
    const order = `RR2${r}`;
    const id = await payment({ status: 'AUTHORIZING', provider: 'REDSYS', amount: 3300, fee: 330, order,
      attempts: [{ order, amount: 3830, tip: 200 }] });
    expect(await h.returns.process(order, bankFields(order, 100))).toBe('enviado');
    await processor.process({ data: { deliveryId: h.jobs[0]! } } as Job<{ deliveryId: string }>);
    expect((await statusOf(id))?.status).toBe('AUTHORIZING');
    const events = await eventsOf(id, 'payment.amount_mismatch');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ chargedCents: 100, expectedCents: 3830 });
  });
});
