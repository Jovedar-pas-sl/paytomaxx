// Integración (Postgres real): la pasarela no abre el pago. Un fallo pasajero
// deja el cobro como estaba (y el reintento abre el pago de verdad); uno
// definitivo lo deja FAILED y la página no ofrece reintentar; al reintentar
// con Redsys un definitivo no mata el cobro (un intento anterior sigue). Con la
// transición real (fila bloqueada, FSM), np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { GatewayTransientError } from '../../src/modules/gateways/gateway-errors';
import type { CheckoutChoice } from '../../src/modules/payments/pay-redirect';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
};
const realtime = { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() };
const orphanQueue = { add: vi.fn(async () => undefined) };
const FORM = { action: 'https://sis-t.redsys.es:25443/sis/realizarPago', method: 'POST' as const, fields: { Ds_Signature: 'x' } };
/** La pasarela de mentira: cada prueba dice qué hace authorize(). */
const authorize = vi.fn<(input: { paymentId: string }) => Promise<unknown>>();
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  orphanQueue as never,
  orphanQueue as never,
  { get: () => ({ authorize }) } as never,
  realtime as never,
  metrics as never,
  {} as never,
  {} as never,
);

/** Como una petición pública de /pay (sin local ni persona en el contexto). */
const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const choice: CheckoutChoice = { tipCents: 0, method: 'card', language: 'es', claimHash: 'huella-cliente' };
const r = randomUUID().slice(0, 6);
let A: string;
let term: string;
let chica: string;
let orders = 0;
const nextOrder = () => `${r}${String((orders += 1)).padStart(4, '0')}`.slice(0, 12);

async function newPayment(o: { status?: string; provider?: 'REDSYS'; order?: string; deniedOrder?: string } = {}) {
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        createdByUserId: chica,
        idempotencyKey: `k-${randomUUID()}`,
        amountCents: 4_500,
        availableAmountCents: 4_500,
        qrToken: `qr-${randomUUID()}`,
        qrExpiresAt: new Date(Date.now() + 4 * 60_000),
        status: (o.status ?? 'CREATED') as never,
        provider: o.provider ?? null,
        providerTxId: o.order ?? null,
        revenueCategory: 'CHICA_SERVICE',
      },
    });
    if (o.deniedOrder) {
      await tx.paymentAttempt.create({
        data: {
          paymentId: p.id,
          tenantId: A,
          provider: 'REDSYS',
          providerTxId: o.deniedOrder,
          amountCents: 4_500,
          tipCents: 0,
          status: 'DENIED',
          createdAt: new Date(Date.now() - 60_000),
        },
      });
    }
    return { id: p.id, qrToken: p.qrToken };
  });
}

const stateOf = (id: string) =>
  sys(async (tx) => ({
    payment: await tx.payment.findUniqueOrThrow({ where: { id } }),
    attempts: await tx.paymentAttempt.findMany({ where: { paymentId: id }, orderBy: { createdAt: 'asc' } }),
    events: (await tx.paymentEvent.findMany({ where: { paymentId: id }, orderBy: { id: 'asc' } })).map((e) => e.eventType),
  }));

const codeOf = (err: unknown) => ((err as ConflictException).getResponse() as { code?: string }).code;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Pasarela', slug: `pas-${r}` } })).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TPAS-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    chica = (await tx.user.create({ data: { tenantId: A, email: `op-pas-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la pasarela no abre el primer pago (Postgres real)', () => {
  it('fallo pasajero: el cobro sigue CREATED (sin pedido, sin intento, sin eventos) y el reintento abre el pago', async () => {
    const p = await newPayment();
    authorize.mockReset();
    authorize.mockRejectedValueOnce(new GatewayTransientError('Redsys: Breaker is open'));
    const err = await pub(() => payments.startCheckout(p.qrToken, choice)).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('GATEWAY_RETRY');

    const after = await stateOf(p.id);
    expect(after.payment).toMatchObject({ status: 'CREATED', provider: null, providerTxId: null, gatewayCheckoutForm: null });
    expect(after.attempts).toHaveLength(0);
    expect(after.events).toEqual([]);
    // «Intentar otra vez» → la página de pago de siempre.
    await expect(pub(() => payments.getPayPage(p.qrToken))).resolves.toMatchObject({ kind: 'choose' });

    // La pasarela ya responde: el mismo cobro abre su pedido.
    const order = nextOrder();
    authorize.mockResolvedValueOnce({ provider: 'REDSYS', providerTxId: order, status: 'PROCESSING', checkoutForm: FORM });
    await expect(pub(() => payments.startCheckout(p.qrToken, choice))).resolves.toEqual({ kind: 'checkout', order });
    const opened = await stateOf(p.id);
    expect(opened.payment).toMatchObject({ status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order });
    expect(opened.attempts).toEqual([expect.objectContaining({ providerTxId: order, status: 'PENDING', claimHash: 'huella-cliente' })]);
    expect(opened.events).toEqual(['payment.authorizing']);
  });

  it('fallo definitivo: el cobro queda FAILED (CHECKOUT_FAILED con su motivo) y la página dice lo mismo', async () => {
    const p = await newPayment({ status: 'AWAITING_CAPTURE' });
    authorize.mockReset();
    authorize.mockRejectedValueOnce(new Error('REDSYS_SECRET_KEY no configurado'));
    const err = await pub(() => payments.startCheckout(p.qrToken, choice)).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('GATEWAY_FAILED');

    const after = await stateOf(p.id);
    expect(after.payment.status).toBe('FAILED');
    expect(after.attempts).toHaveLength(0);
    expect(after.events).toEqual(['payment.checkout_failed']);
    const event = await sys((tx) => tx.paymentEvent.findFirstOrThrow({ where: { paymentId: p.id } }));
    expect(event.payload).toMatchObject({ type: 'CHECKOUT_FAILED', reason: 'gateway-authorize-error' });
    await expect(pub(() => payments.getPayPage(p.qrToken))).resolves.toEqual({ kind: 'closed', reason: 'failed' });
  });

  it('dos «Pagar» a la vez: los dos preparan el pago, uno lo abre y del otro no queda nada', async () => {
    const p = await newPayment();
    authorize.mockReset();
    authorize.mockImplementation(async () => ({ provider: 'REDSYS', providerTxId: nextOrder(), status: 'PROCESSING', checkoutForm: FORM }));
    const results = await Promise.allSettled([
      pub(() => payments.startAuthorization(p.qrToken, choice)),
      pub(() => payments.startAuthorization(p.qrToken, choice)),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    const ko = results.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const after = await stateOf(p.id);
    const winner = (ok[0] as PromiseFulfilledResult<{ providerTxId?: string }>).value.providerTxId;
    expect(after.payment).toMatchObject({ status: 'AUTHORIZING', providerTxId: winner });
    expect(after.attempts.map((a) => a.providerTxId)).toEqual([winner]);
    expect(after.events).toEqual(['payment.authorizing']);
  });
});

describe('la pasarela no abre OTRO intento con Redsys (Postgres real)', () => {
  it('definitivo: el cobro sigue AUTHORIZING con su intento anterior; sin intento nuevo', async () => {
    const denied = nextOrder();
    const p = await newPayment({ status: 'AUTHORIZING', provider: 'REDSYS', order: denied, deniedOrder: denied });
    authorize.mockReset();
    authorize.mockRejectedValueOnce(new Error('REDSYS_MERCHANT_CODE no configurado'));
    const err = await pub(() => payments.startCheckout(p.qrToken, choice)).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('GATEWAY_FAILED_AFTER_ATTEMPT');

    const after = await stateOf(p.id);
    expect(after.payment).toMatchObject({ status: 'AUTHORIZING', providerTxId: denied });
    expect(after.attempts.map((a) => a.providerTxId)).toEqual([denied]);
  });

  it('pasajero: igual, sin intento nuevo, y el reintento sí abre el pedido nuevo', async () => {
    const denied = nextOrder();
    const p = await newPayment({ status: 'AUTHORIZING', provider: 'REDSYS', order: denied, deniedOrder: denied });
    authorize.mockReset();
    authorize.mockRejectedValueOnce(Object.assign(new Error('Breaker is open'), { code: 'EOPENBREAKER' }));
    const err = await pub(() => payments.startCheckout(p.qrToken, choice)).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('GATEWAY_RETRY');
    expect((await stateOf(p.id)).attempts).toHaveLength(1);

    await expect(pub(() => payments.getPayPage(p.qrToken))).resolves.toMatchObject({ kind: 'choose' });
    const order = nextOrder();
    authorize.mockResolvedValueOnce({ provider: 'REDSYS', providerTxId: order, status: 'PROCESSING', checkoutForm: FORM });
    await expect(pub(() => payments.startCheckout(p.qrToken, choice))).resolves.toEqual({ kind: 'checkout', order });
    const after = await stateOf(p.id);
    expect(after.payment).toMatchObject({ status: 'AUTHORIZING', providerTxId: order });
    expect(after.attempts.map((a) => a.providerTxId)).toEqual([denied, order]);
  });
});
