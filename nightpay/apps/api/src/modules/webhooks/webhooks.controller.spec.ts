import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WebhooksController } from './webhooks.controller';

interface MakeOptions {
  verifyResult?:
    | { valid: true; externalEventId: string; paymentRef: string }
    | { valid: false; reason: string };
  existingDelivery?: { id: bigint; processedAt: Date | null } | null;
}

function makeController(opts: MakeOptions = {}) {
  const adapter = {
    verifyWebhook: vi.fn().mockReturnValue(
      opts.verifyResult ?? { valid: true, externalEventId: 'evt-1', paymentRef: 'pay-1' },
    ),
  };
  const gateways = { get: vi.fn().mockReturnValue(adapter) };

  const prisma = {
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(opts.existingDelivery ?? null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: BigInt(42),
        processedAt: null,
        ...data,
      })),
    },
  };

  const queue = { add: vi.fn().mockResolvedValue(undefined) };

  const metrics = {
    webhooksReceived: { inc: vi.fn() },
  };

  const controller = new WebhooksController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gateways as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metrics as any,
  );

  return { controller, adapter, gateways, prisma, queue, metrics };
}

function fakeRequest(body: unknown = { event_id: 'evt-1' }): FastifyRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    headers: { 'x-signature': 'aabbcc', 'x-timestamp': String(Date.now()) },
    body,
  } as any;
}

describe('WebhooksController.receive — provider validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown providers with 400', async () => {
    const { controller } = makeController();
    await expect(controller.receive('GOOGLEPAY', fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });

  it.each(['wipay', 'WIPAY', 'WiPay'])(
    'accepts case-insensitive %s as WIPAY',
    async (param) => {
      const { controller, gateways } = makeController();
      await controller.receive(param, fakeRequest());
      expect(gateways.get).toHaveBeenCalledWith('WIPAY');
    },
  );

  it('rejects PEANPE on generic endpoint (uses challenge-response route)', async () => {
    const { controller } = makeController();
    // Peanpe v2.0 doc usa flow distinto (POST notify + GET notify con seguridad).
    // El endpoint genérico /webhooks/:provider rechaza PEANPE para forzar al
    // caller a usar la ruta dedicada /webhooks/peanpe/notify.
    await expect(controller.receive('peanpe', fakeRequest())).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('WebhooksController.receive — signature verification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when adapter says invalid', async () => {
    const { controller, metrics, queue } = makeController({
      verifyResult: { valid: false, reason: 'signature-mismatch' },
    });
    await expect(controller.receive('wipay', fakeRequest())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'invalid',
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns 400 when externalEventId is missing from a valid response', async () => {
    const { controller, metrics } = makeController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyResult: { valid: true, externalEventId: '', paymentRef: 'pay-1' } as any,
    });
    await expect(controller.receive('wipay', fakeRequest())).rejects.toThrow(BadRequestException);
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'invalid',
    });
  });
});

describe('WebhooksController.receive — idempotency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns duplicate=true and skips queue when delivery already processed', async () => {
    const { controller, queue, metrics } = makeController({
      existingDelivery: { id: BigInt(99), processedAt: new Date() },
    });
    const result = await controller.receive('wipay', fakeRequest());
    expect(result).toEqual({ received: true, duplicate: true });
    expect(queue.add).not.toHaveBeenCalled();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'duplicate',
    });
  });

  it('reuses existing delivery row if not yet processed (retried before processing)', async () => {
    const existing = { id: BigInt(99), processedAt: null };
    const { controller, prisma, queue } = makeController({ existingDelivery: existing });
    const result = await controller.receive('wipay', fakeRequest());
    expect(result).toEqual({ received: true });
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '99' },
      expect.objectContaining({ jobId: 'webhook-WIPAY-evt-1' }),
    );
  });

  it('creates a new delivery row + enqueues for fresh events', async () => {
    const { controller, prisma, queue, metrics } = makeController();
    const result = await controller.receive('wipay', fakeRequest());
    expect(result).toEqual({ received: true });
    expect(prisma.webhookDelivery.create).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'valid',
    });
  });

  it('uses deterministic jobId per (provider, externalEventId) for BullMQ idempotency', async () => {
    const { controller, queue } = makeController({
      verifyResult: { valid: true, externalEventId: 'unique-evt-77', paymentRef: 'pay-1' },
    });
    // Probamos con WIPAY (Peanpe v2.0 usa ruta dedicada con flujo distinto).
    await controller.receive('wipay', fakeRequest());
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      expect.any(Object),
      expect.objectContaining({ jobId: 'webhook-WIPAY-unique-evt-77' }),
    );
  });

  it('configures retries with exponential backoff', async () => {
    const { controller, queue } = makeController();
    await controller.receive('wipay', fakeRequest());
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });
});
