import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { WebhookIngestProcessor } from './webhook-ingest.processor';
import { InvalidTransitionError } from '../payments/payment.machine';
import type { ApprovalProof } from '../gateways/gateway.adapter';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

interface Options {
  rawBody?: string;
  provider?: string;
  /** Lo que dice el aviso (evento FSM que mapea el adapter). */
  event?: Record<string, unknown> | null;
  paymentId?: string;
  proof?: ApprovalProof;
  /** Intento de ese pedido en payment_attempts (importe mandado al banco). */
  attempt?: { amountCents: number | null } | null;
  payment?: { amountCents: number; currency: string; provider?: string } | null;
}

function makeProcessor(o: Options = {}) {
  const provider = o.provider ?? 'REDSYS';
  const tx = {
    paymentAttempt: { findFirst: vi.fn().mockResolvedValue(o.attempt === undefined ? { amountCents: 4850 } : o.attempt) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    webhookDelivery: { update: vi.fn().mockResolvedValue(undefined) },
  };
  const payment =
    o.payment === null
      ? null
      : {
          id: o.paymentId ?? PAYMENT_ID,
          tenantId: TENANT_ID,
          provider: o.payment?.provider ?? provider,
          amountCents: o.payment?.amountCents ?? 4850,
          currency: o.payment?.currency ?? 'EUR',
        };
  const prisma = {
    // El cobro es de la misma pasarela que el aviso.
    payment: { findUnique: vi.fn().mockResolvedValue(payment) },
    webhookDelivery: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: BigInt(7),
        provider,
        tenantId: TENANT_ID,
        processedAt: null,
        rawBody: Buffer.from(o.rawBody ?? '{"x":1}', 'utf8'),
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    asSystem: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const payments = { transition: vi.fn().mockResolvedValue(undefined) };
  const adapter = {
    provider,
    mapWebhookToFsmEvent: vi.fn().mockReturnValue(
      o.event === null
        ? null
        : {
            paymentId: o.paymentId ?? PAYMENT_ID,
            event: o.event ?? { type: 'AUTHORIZED', providerTxId: 'abc123def456', provider },
          },
    ),
    proveApproval: vi
      .fn()
      .mockResolvedValue(o.proof ?? { kind: 'confirmed', amountCents: 4850, currency: 'EUR' }),
  };
  const gateways = { get: vi.fn().mockReturnValue(adapter) };
  const processor = new WebhookIngestProcessor(prisma as any, payments as any, gateways as any);
  const job = { data: { deliveryId: '7' } } as Job<{ deliveryId: string }>;
  return { processor, prisma, tx, payments, adapter, job };
}

/** El aviso quedó procesado (fuera o dentro de la transacción de la incidencia). */
function closed(m: ReturnType<typeof makeProcessor>): boolean {
  return m.prisma.webhookDelivery.update.mock.calls.length + m.tx.webhookDelivery.update.mock.calls.length > 0;
}

describe('WebhookIngestProcessor — formato del body persistido', () => {
  it('procesa body form-urlencoded (Redsys) sin intentar JSON.parse', async () => {
    const m = makeProcessor({
      rawBody: `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=eyJ9&Ds_Signature=sig&_paymentId=${PAYMENT_ID}`,
    });

    await m.processor.process(m.job);

    expect(m.adapter.mapWebhookToFsmEvent).toHaveBeenCalledWith(
      expect.objectContaining({ Ds_Signature: 'sig', _paymentId: PAYMENT_ID }),
    );
    expect(m.payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.objectContaining({ type: 'AUTHORIZED' }),
      TENANT_ID,
    );
    expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
  });

  it('sigue procesando body JSON (Peanpe/Paytef)', async () => {
    const m = makeProcessor({ rawBody: JSON.stringify({ status: '200', _paymentId: PAYMENT_ID }), provider: 'PAYTEF' });

    await m.processor.process(m.job);

    expect(m.adapter.mapWebhookToFsmEvent).toHaveBeenCalledWith({ status: '200', _paymentId: PAYMENT_ID });
    expect(m.payments.transition).toHaveBeenCalled();
  });
});

describe('WebhookIngestProcessor — cada pasarela solo toca sus cobros', () => {
  it('un aviso de Paytef no puede marcar pagado un cobro de Redsys', async () => {
    const m = makeProcessor({ provider: 'PAYTEF', payment: { amountCents: 4850, currency: 'EUR', provider: 'REDSYS' } });
    await m.processor.process(m.job as never);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.adapter.proveApproval).not.toHaveBeenCalled();
    expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
  });

  it('un id de cobro que no es UUID no se busca (ni se reintenta): se ignora', async () => {
    const m = makeProcessor({ paymentId: 'no-es-un-uuid' });
    await m.processor.process(m.job);
    expect(m.prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
  });
});

describe('WebhookIngestProcessor — un aviso "aprobado" hay que probarlo (#1 #2 #51)', () => {
  it('prueba de la pasarela + importe del intento (con propina) → se da por pagado', async () => {
    const m = makeProcessor({
      attempt: { amountCents: 5350 },
      proof: { kind: 'confirmed', amountCents: 5350, currency: 'EUR' },
    });
    await m.processor.process(m.job);
    expect(m.adapter.proveApproval).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      providerTxId: 'abc123def456',
      payload: { x: 1 },
    });
    expect(m.tx.paymentAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: PAYMENT_ID, provider: 'REDSYS', providerTxId: 'abc123def456' } }),
    );
    expect(m.payments.transition).toHaveBeenCalled();
    expect(m.tx.paymentEvent.create).not.toHaveBeenCalled();
  });

  it('sin intento registrado (cobro antiguo) → se compara con el importe del cobro', async () => {
    const m = makeProcessor({ attempt: null, payment: { amountCents: 2000, currency: 'EUR' } });
    m.adapter.proveApproval.mockResolvedValue({ kind: 'confirmed', amountCents: 2000, currency: null });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalled();
  });

  it('aviso que no se puede comprobar (Peanpe) → NO se marca pagado; incidencia y aviso cerrado', async () => {
    const m = makeProcessor({ provider: 'PEANPE', proof: { kind: 'unverifiable', reason: 'peanpe-sin-consulta' } });
    await m.processor.process(m.job);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: PAYMENT_ID,
        tenantId: TENANT_ID,
        eventType: 'payment.approval_unverified',
        payload: expect.objectContaining({ provider: 'PEANPE', reason: 'peanpe-sin-consulta', deliveryId: '7' }),
      }),
    });
    // La incidencia y el "procesado" van juntos (misma transacción).
    expect(m.tx.webhookDelivery.update).toHaveBeenCalled();
    expect(m.prisma.webhookDelivery.update).not.toHaveBeenCalled();
  });

  it('la pasarela dice que no está aprobado (aviso falso) → incidencia, sin pagar', async () => {
    const m = makeProcessor({ provider: 'PAYTEF', proof: { kind: 'rejected', reason: 'paytef-no-aprobado' } });
    await m.processor.process(m.job);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data.eventType).toBe('payment.approval_unverified');
  });

  it('importe distinto del mandado al banco → NO se marca pagado; incidencia con los dos importes', async () => {
    const m = makeProcessor({ attempt: { amountCents: 4850 }, proof: { kind: 'confirmed', amountCents: 100, currency: 'EUR' } });
    await m.processor.process(m.job);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'payment.amount_mismatch',
      payload: { chargedCents: 100, expectedCents: 4850, providerTxId: 'abc123def456' },
    });
  });

  it('moneda distinta → también es un importe que no cuadra', async () => {
    const m = makeProcessor({ proof: { kind: 'confirmed', amountCents: 4850, currency: 'USD' } });
    await m.processor.process(m.job);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data.eventType).toBe('payment.amount_mismatch');
  });

  it('la pasarela no responde → se lanza para que BullMQ reintente (nada se marca)', async () => {
    const m = makeProcessor({ provider: 'PAYTEF', proof: { kind: 'unavailable', reason: 'paytef-http-503' } });
    await expect(m.processor.process(m.job)).rejects.toThrow(/paytef-http-503/);
    expect(m.payments.transition).not.toHaveBeenCalled();
    expect(closed(m)).toBe(false);
  });

  it('los avisos que no son aprobaciones no piden prueba', async () => {
    const m = makeProcessor({ provider: 'PAYTEF', event: { type: 'FAILED', reason: 'expired' } });
    await m.processor.process(m.job);
    expect(m.adapter.proveApproval).not.toHaveBeenCalled();
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'FAILED', reason: 'expired' }, TENANT_ID);
  });
});

describe('WebhookIngestProcessor — aprobación del banco que no se puede apuntar (#5)', () => {
  it('cobro caducado/cancelado → incidencia "approval_unbooked" y aviso cerrado (sin 5 reintentos)', async () => {
    const m = makeProcessor();
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('EXPIRED', 'AUTHORIZED'));
    await m.processor.process(m.job);
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'payment.approval_unbooked',
      payload: { fromStatus: 'EXPIRED', providerTxId: 'abc123def456' },
    });
    expect(m.tx.webhookDelivery.update).toHaveBeenCalled();
  });

  it('aprobación repetida de un cobro ya pagado → idempotente, sin incidencia', async () => {
    const m = makeProcessor();
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZED', 'AUTHORIZED'));
    await m.processor.process(m.job);
    expect(m.tx.paymentEvent.create).not.toHaveBeenCalled();
    expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
  });

  it('un evento que no es aprobación en un estado imposible → se relanza (reintento visible)', async () => {
    const m = makeProcessor({ provider: 'PAYTEF', event: { type: 'FAILED', reason: 'canceled' } });
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('CREATED', 'FAILED'));
    await expect(m.processor.process(m.job)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(closed(m)).toBe(false);
  });
});
