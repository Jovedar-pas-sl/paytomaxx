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
  // El cobro se busca con asSystem (trabajo sin local): la misma búsqueda dentro de la transacción.
  Object.assign(tx, { payment: prisma.payment });
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

describe('recuperación rápida de la cola de avisos', () => {
  it('reintenta una conexión fallida en un segundo y procesa hasta 4 avisos a la vez', () => {
    const options = Reflect.getMetadata('bullmq:worker_metadata', WebhookIngestProcessor) as { runRetryDelay?: number; concurrency?: number } | undefined;
    expect(options?.runRetryDelay).toBe(1000);
    expect(options?.concurrency).toBe(4);
  });
});

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

describe('WebhookIngestProcessor — cobro único: la tarjeta aprobada después de pagar con el saldo', () => {
  /** El cobro con tarjeta se canceló porque lo pagó el saldo; `handled`: pedidos ya tratados. */
  function paidWithSaldo(refund: () => Promise<unknown>, handled: string[] = []) {
    const m = makeProcessor({ provider: 'PAYTEF' });
    Object.assign(m.tx.paymentEvent, {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue(handled.map((providerTxId) => ({ payload: { providerTxId } }))),
    });
    Object.assign(m.adapter, { refund: vi.fn(refund) });
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('CANCELED', 'AUTHORIZED'));
    return m;
  }

  it('la pasarela devuelve por API → se devuelve sola, evento informativo y aviso cerrado', async () => {
    const m = paidWithSaldo(async () => ({ providerRefundId: 'RF-9', status: 'SUCCEEDED' }));
    await m.processor.process(m.job);
    expect((m.adapter as unknown as { refund: ReturnType<typeof vi.fn> }).refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, providerTxId: 'abc123def456', amountCents: 4850 }),
    );
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'payment.card_refunded_after_saldo',
      payload: { providerTxId: 'abc123def456', providerRefundId: 'RF-9' },
    });
    expect(m.tx.webhookDelivery.update).toHaveBeenCalled();
  });

  it('sin devolución por API → incidencia «cobrado dos veces» (paid_with_saldo), aviso cerrado', async () => {
    const m = paidWithSaldo(async () => {
      throw new Error('no implementado');
    });
    await m.processor.process(m.job);
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'payment.approval_unbooked',
      payload: { reason: 'paid_with_saldo', fromStatus: 'CANCELED', providerTxId: 'abc123def456' },
    });
    expect(closed(m)).toBe(true);
  });

  it('el mismo aviso otra vez → solo se cierra (ni otra devolución ni otra incidencia)', async () => {
    const refund = vi.fn(async () => ({ providerRefundId: 'x', status: 'SUCCEEDED' }));
    const m = paidWithSaldo(refund, ['abc123def456']);
    await m.processor.process(m.job);
    expect(refund).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create).not.toHaveBeenCalled();
    expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
  });
});

describe('WebhookIngestProcessor — pagó después de cancelar (el personal canceló con el cliente en su banco)', () => {
  /** Cobro cancelado por el personal (no por el saldo); `already`: el pedido ya tiene su incidencia. */
  function canceledByStaff(already = false) {
    const m = makeProcessor();
    Object.assign(m.tx.paymentEvent, { count: vi.fn().mockResolvedValue(0) });
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM payment_events') && already ? [{ one: 1 }] : [],
    );
    Object.assign(m.tx, { $queryRaw: queryRaw });
    const refund = vi.fn();
    Object.assign(m.adapter, { refund });
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('CANCELED', 'AUTHORIZED'));
    return { ...m, queryRaw, refund };
  }

  it('aviso firmado tardío → incidencia «paid_after_cancel» con el importe del intento, sin devolver, aviso cerrado', async () => {
    const m = canceledByStaff();
    await m.processor.process(m.job);
    expect(m.refund).not.toHaveBeenCalled();
    expect(m.tx.paymentEvent.create).toHaveBeenCalledTimes(1);
    expect(m.tx.paymentEvent.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'payment.approval_unbooked',
      payload: { reason: 'paid_after_cancel', fromStatus: 'CANCELED', providerTxId: 'abc123def456', amountCents: 4850, source: 'aviso', deliveryId: '7' },
    });
    // Con el cobro bloqueado y en la misma transacción que cierra el aviso.
    expect(String(m.queryRaw.mock.calls[0]![0].join('?'))).toContain('FOR UPDATE');
    expect(m.tx.webhookDelivery.update).toHaveBeenCalled();
  });

  it('el mismo pedido otra vez → solo se cierra el aviso (una sola incidencia)', async () => {
    const m = canceledByStaff(true);
    await m.processor.process(m.job);
    expect(m.tx.paymentEvent.create).not.toHaveBeenCalled();
    expect(m.refund).not.toHaveBeenCalled();
    expect(m.tx.webhookDelivery.update).toHaveBeenCalled();
  });
});

describe('WebhookIngestProcessor — avisos que nombran el intento, no el cobro (Paytef clientID, Cecabank Num_operacion; FSD-02)', () => {
  const ATTEMPT_ID = '0d4e7c21-58f3-4b19-8e02-9c7d6b5e4f30';

  function namingAttempt(o: { attempt?: { paymentId: string; provider: string } | null } = {}) {
    const m = makeProcessor({ provider: 'PAYTEF', paymentId: ATTEMPT_ID, attempt: { amountCents: 4850 } });
    // Sin cobro con ese id: es el de un intento.
    m.prisma.payment.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === PAYMENT_ID ? { id: PAYMENT_ID, tenantId: TENANT_ID, provider: 'PAYTEF', amountCents: 4850, currency: 'EUR' } : null,
    );
    const attempt = o.attempt === undefined ? { paymentId: PAYMENT_ID, provider: 'PAYTEF' } : o.attempt;
    Object.assign(m.tx.paymentAttempt, { findUnique: vi.fn().mockResolvedValue(attempt) });
    m.tx.paymentAttempt.findFirst.mockResolvedValue({ id: ATTEMPT_ID, amountCents: 4850 });
    return m;
  }

  it('se resuelve a su cobro: la prueba lleva el intento y se apunta en el cobro', async () => {
    const m = namingAttempt();
    await m.processor.process(m.job);
    expect(m.adapter.proveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, providerTxId: 'abc123def456', attemptId: ATTEMPT_ID }),
    );
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ type: 'AUTHORIZED' }), TENANT_ID);
  });

  it('un intento de otra pasarela no vale (ni un id que no es de nada)', async () => {
    for (const attempt of [{ paymentId: PAYMENT_ID, provider: 'REDSYS' }, null]) {
      const m = namingAttempt({ attempt });
      await m.processor.process(m.job);
      expect(m.payments.transition).not.toHaveBeenCalled();
      expect(m.prisma.webhookDelivery.update).toHaveBeenCalled();
    }
  });
});
