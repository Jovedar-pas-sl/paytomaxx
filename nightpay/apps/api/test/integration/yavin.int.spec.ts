// Integración (Postgres real, RLS forzado): Yavin como segunda pasarela de
// tarjeta (enlace de pago con QR). Yavin es de mentira (fetch simulado): nunca
// se llama al de verdad, y la clave es inventada. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { YavinAdapter } from '../../src/modules/gateways/yavin.adapter';
import { sealYavinKey } from '../../src/modules/gateways/yavin-credential';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { WebhooksController } from '../../src/modules/webhooks/webhooks.controller';
import { YavinCancelHook } from '../../src/modules/payments/yavin-cancel.hook';
import { assertYavinFirstRefund } from '../../src/modules/refunds/yavin-refund';
import type { CheckoutChoice } from '../../src/modules/payments/pay-redirect';

const KEK = process.env.ENCRYPTION_KEK!;
const FAKE_KEY = 'clave-yavin-inventada-para-pruebas';
const YAVIN = 'http://yavin.simulado';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const metrics = {
  paymentsCreated: { inc: noop },
  paymentsTransitioned: { inc: noop },
  walletCreditSkipped: { inc: noop },
  duplicateCharges: { inc: noop },
  webhooksReceived: { inc: noop },
  gatewayDuration: { observe: noop },
  circuitState: { set: noop },
};
const config = {
  get: (k: string) =>
    ({ GATEWAY_TIMEOUT_MS: 5000, YAVIN_API_URL: YAVIN, ENCRYPTION_KEK: KEK, NEXT_PUBLIC_API_URL: 'https://api.ejemplo.test' })[k],
};
const yavin = new YavinAdapter(config as never, metrics as never, prisma as never);
/** Redsys (BBVA) de mentira: su formulario, para ver que el cobro fue por ahí. */
const redsysAuthorize = vi.fn(async () => ({
  provider: 'REDSYS',
  providerTxId: `R${randomUUID().slice(0, 10)}`,
  status: 'PROCESSING',
  checkoutForm: { action: 'https://sis-t.redsys.es:25443/sis/realizarPago', method: 'POST', fields: { Ds_Signature: 'x' } },
}));
const redsys = { provider: 'REDSYS', authorize: redsysAuthorize };
const registry = { get: (p: string) => (p === 'YAVIN' ? yavin : redsys) };
const orphanQueue = { getJob: async () => undefined, add: async () => undefined };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  orphanQueue as never,
  orphanQueue as never,
  registry as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const processor = new WebhookIngestProcessor(prisma as never, payments as never, registry as never);
const queue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => undefined) };
const webhooks = new WebhooksController(
  prisma as never,
  registry as never,
  queue as never,
  metrics as never,
  config as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  undefined,
  { get: () => processor } as never,
  yavin,
);
new YavinCancelHook(prisma, payments, yavin).onModuleInit();

// ─── Yavin de mentira ───────────────────────────────────────────────
interface FakeCart {
  status: string;
  amount: number;
  order_id: string;
  webhook: string;
}
const carts = new Map<string, FakeCart>();
const calls: Array<{ path: string; body: Record<string, unknown>; secret: string | undefined }> = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
const fakeYavin = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const path = String(url).replace(YAVIN, '');
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  calls.push({ path, body, secret: (init?.headers as Record<string, string> | undefined)?.['Yavin-Secret'] });
  if (path === '/api/v5/ecommerce/generate_link/') {
    const cartId = `cart-${randomUUID().slice(0, 8)}`;
    carts.set(cartId, { status: 'pending', amount: Number(body.amount), order_id: String(body.order_id), webhook: String(body.webhook_url) });
    return json(200, { link: `https://pay.yavin.simulado/${cartId}`, cart_id: cartId });
  }
  if (path === '/api/v5/ecommerce/get_cart_information/') {
    const cart = carts.get(String(body.cart_id));
    return cart ? json(200, { status: cart.status, amount: cart.amount, currency: 'EUR', order_id: cart.order_id }) : json(404, {});
  }
  if (path === '/api/v5/ecommerce/cancel_link/') {
    const cart = carts.get(String(body.cart_id));
    if (cart) cart.status = 'cancelled';
    return json(200, {});
  }
  return json(404, {});
});

const inCtx = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-yavin' });
    return fn();
  });
const pub = <T>(fn: () => Promise<T>) => inCtx(undefined, fn);
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const choice: CheckoutChoice = { tipCents: 0, method: 'card', language: 'es', claimHash: 'huella-cliente' };
const r = randomUUID().slice(0, 6);
let A: string, waiter: string, term: string;

async function newPayment(amount = 2_500): Promise<{ id: string; qrToken: string }> {
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        createdByUserId: waiter,
        idempotencyKey: `k-${randomUUID()}`,
        amountCents: amount,
        availableAmountCents: amount,
        qrToken: `qr-${randomUUID()}`,
        qrExpiresAt: new Date(Date.now() + 10 * 60_000),
        status: 'CREATED',
        revenueCategory: 'VENUE_BAR',
      },
    });
    return { id: p.id, qrToken: p.qrToken };
  });
}

/** Abre el cobro como el cliente al pulsar «Pagar»: va a la página de Yavin. Devuelve el carrito y el token del aviso. */
async function openWithYavin(p: { id: string; qrToken: string }): Promise<{ cartId: string; token: string }> {
  const view = await pub(() => payments.startCheckout(p.qrToken, choice));
  expect(view).toMatchObject({ kind: 'redirect' });
  const attempt = await sys((tx) => tx.paymentAttempt.findFirstOrThrow({ where: { paymentId: p.id } }));
  const cart = carts.get(attempt.providerTxId)!;
  return { cartId: attempt.providerTxId, token: cart.webhook.split('/').pop()! };
}

const paymentOf = (id: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { id } }));
const deliveriesOf = (cartId: string) => prisma.webhookDelivery.count({ where: { provider: 'YAVIN', externalEventId: `${cartId}_paid` } });

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Yavin', slug: `yav-${r}`, yavinSelected: true } })).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TYAV-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    waiter = (await tx.user.create({ data: { tenantId: A, email: `cam-yav-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    // La pasarela de siempre (BBVA) y la clave de Yavin cifrada, como la guarda el super-admin.
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1, createdAt: new Date(Date.now() - 86_400_000) },
    });
    await tx.gatewayCredential.create({ data: { tenantId: A, provider: 'YAVIN', active: true, ...sealYavinKey(KEK, A, FAKE_KEY) } });
  });
});

beforeEach(() => {
  vi.stubEnv('YAVIN_ENABLED', 'true');
  globalThis.fetch = fakeYavin as never;
  calls.length = 0;
  redsysAuthorize.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Yavin: abrir el cobro', () => {
  it('local con Yavin elegido: el cliente va a la página de Yavin; el intento guarda solo la huella del token', async () => {
    const p = await newPayment();
    const { cartId, token } = await openWithYavin(p);
    const payment = await paymentOf(p.id);
    expect(payment).toMatchObject({ status: 'AUTHORIZING', provider: 'YAVIN', providerTxId: cartId, gatewayPaymentUrl: `https://pay.yavin.simulado/${cartId}` });
    expect(redsysAuthorize).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ path: '/api/v5/ecommerce/generate_link/', secret: FAKE_KEY, body: { amount: 2500, order_id: p.id } });
    const attempt = await sys((tx) => tx.paymentAttempt.findFirstOrThrow({ where: { paymentId: p.id } }));
    expect(attempt.noticeTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.noticeTokenHash).not.toBe(token);
    // Ni la clave ni el token en la base en claro.
    const dump = JSON.stringify(await sys((tx) => tx.gatewayCredential.findMany({ where: { tenantId: A } })));
    expect(dump).not.toContain(FAKE_KEY);
    expect(JSON.stringify(attempt)).not.toContain(token);
  });
});

describe('Yavin: el aviso (sin firma)', () => {
  it('token malo → 401 y nada cambia', async () => {
    const p = await newPayment();
    const { cartId } = await openWithYavin(p);
    carts.get(cartId)!.status = 'paid';
    for (const bad of ['x', 'A'.repeat(43), `${'B'.repeat(42)}!`]) {
      await expect(webhooks.receiveYavin(bad)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect((await paymentOf(p.id)).status).toBe('AUTHORIZING');
    expect(await deliveriesOf(cartId)).toBe(0);
    // Con token malo ni se pregunta a Yavin.
    expect(calls.filter((c) => c.path.includes('get_cart_information'))).toHaveLength(0);
  });

  it('aviso bueno pero Yavin dice que no está pagado → 200 y el cobro sigue esperando', async () => {
    const p = await newPayment();
    const { cartId, token } = await openWithYavin(p);
    await expect(webhooks.receiveYavin(token)).resolves.toEqual({ received: true });
    expect((await paymentOf(p.id)).status).toBe('AUTHORIZING');
    expect(await deliveriesOf(cartId)).toBe(0);
    expect(calls.filter((c) => c.path === '/api/v5/ecommerce/get_cart_information/')).toHaveLength(1);
  });

  it('pagado → PAGADO una sola vez aunque el aviso llegue dos veces', async () => {
    const p = await newPayment();
    const { cartId, token } = await openWithYavin(p);
    carts.get(cartId)!.status = 'paid';
    await expect(webhooks.receiveYavin(token)).resolves.toEqual({ received: true });
    const paid = await paymentOf(p.id);
    expect(paid.status).toBe('AUTHORIZED');
    expect(paid.authorizedAt).not.toBeNull();
    await expect(webhooks.receiveYavin(token)).resolves.toEqual({ received: true, duplicate: true });
    expect(await deliveriesOf(cartId)).toBe(1);
    const authorized = await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'payment.authorized' } }));
    expect(authorized).toBe(1);
    // El procesador volvió a preguntar a Yavin antes de darlo por pagado (aviso + procesador).
    expect(calls.filter((c) => c.path === '/api/v5/ecommerce/get_cart_information/').length).toBeGreaterThanOrEqual(2);
  });

  it('pagado por otro importe → NO pagado; queda la incidencia', async () => {
    const p = await newPayment();
    const { cartId, token } = await openWithYavin(p);
    Object.assign(carts.get(cartId)!, { status: 'paid', amount: 2_499 });
    await webhooks.receiveYavin(token);
    expect((await paymentOf(p.id)).status).toBe('AUTHORIZING');
    const mismatch = await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'payment.amount_mismatch' } }));
    expect(mismatch).toBe(1);
  });

  it('el token de un cobro no paga otro', async () => {
    const a = await newPayment();
    const b = await newPayment();
    const first = await openWithYavin(a);
    const second = await openWithYavin(b);
    carts.get(second.cartId)!.status = 'paid';
    await webhooks.receiveYavin(first.token);
    expect((await paymentOf(a.id)).status).toBe('AUTHORIZING');
    expect((await paymentOf(b.id)).status).toBe('AUTHORIZING');
  });

  it('Yavin no responde al comprobar → 503 (Yavin lo reintenta) y nada cambia', async () => {
    const p = await newPayment();
    const { token } = await openWithYavin(p);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as never;
    await expect(webhooks.receiveYavin(token)).rejects.toMatchObject({ status: 503 });
    expect((await paymentOf(p.id)).status).toBe('AUTHORIZING');
  });
});

describe('Yavin: cancelar y devolver', () => {
  it('cancelar el cobro → cancel_link en Yavin', async () => {
    const p = await newPayment();
    const { cartId } = await openWithYavin(p);
    // Pasados los 2 minutos «en su banco».
    await sys(async (tx) => {
      const past = new Date(Date.now() - 3 * 60_000);
      await tx.paymentAttempt.updateMany({ where: { paymentId: p.id }, data: { createdAt: past } });
      await tx.paymentEvent.updateMany({ where: { paymentId: p.id }, data: { occurredAt: past } });
    });
    calls.length = 0;
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    expect((await paymentOf(p.id)).status).toBe('CANCELED');
    expect(calls).toEqual([expect.objectContaining({ path: '/api/v5/ecommerce/cancel_link/', body: { cart_id: cartId }, secret: FAKE_KEY })]);
    expect(carts.get(cartId)!.status).toBe('cancelled');
  });

  it('una devolución sí; con una ya pedida o hecha, la segunda se bloquea con mensaje claro', async () => {
    const p = await newPayment();
    const { cartId, token } = await openWithYavin(p);
    carts.get(cartId)!.status = 'paid';
    await webhooks.receiveYavin(token);
    const payment = await paymentOf(p.id);
    await expect(sys((tx) => assertYavinFirstRefund(tx, payment))).resolves.toBeUndefined();
    await sys((tx) => tx.refund.create({ data: { tenantId: A, paymentId: p.id, amountCents: 500, requestedBy: waiter, status: 'SUCCEEDED' } }));
    const err = await sys((tx) => assertYavinFirstRefund(tx, payment)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'YAVIN_ONE_REFUND_ONLY', message: expect.stringContaining('una devolución') });
  });
});

describe('YAVIN_ENABLED apagado: todo como hoy', () => {
  it('el cobro va por BBVA (Redsys) aunque el local tenga Yavin elegido y clave', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    const p = await newPayment();
    await expect(pub(() => payments.startCheckout(p.qrToken, choice))).resolves.toMatchObject({ kind: 'checkout' });
    expect(redsysAuthorize).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect((await paymentOf(p.id)).provider).toBe('REDSYS');
  });

  it('la ruta del aviso de Yavin no existe (404)', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    await expect(webhooks.receiveYavin('A'.repeat(43))).rejects.toBeInstanceOf(NotFoundException);
  });
});
