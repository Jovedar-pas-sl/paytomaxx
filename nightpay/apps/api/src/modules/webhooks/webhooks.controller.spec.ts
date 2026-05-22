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
  // Adapter genérico (mock — usado por el switch /webhooks/:provider para
  // detectar provider PAYTEF/PEANPE/WIPAY que deben usar rutas dedicadas).
  const genericAdapter = {
    verifyWebhook: vi.fn().mockReturnValue(
      opts.verifyResult ?? { valid: true, externalEventId: 'evt-1', paymentRef: 'pay-1' },
    ),
  };
  const gateways = { get: vi.fn().mockReturnValue(genericAdapter) };

  // Wipay adapter (mock — inyectado directamente al controller para
  // la ruta dedicada receiveWipay).
  const wipay = {
    verifyWebhook: vi.fn().mockReturnValue(
      opts.verifyResult ?? { valid: true, externalEventId: 'op-test-1', paymentRef: 'op-test-1' },
    ),
  };

  const peanpe = {
    getSecurityTokenForCall: vi.fn(),
    resolvePaymentFromCallback: vi.fn(),
    persistCallbackResult: vi.fn(),
    verifyWebhook: vi.fn(),
  };

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

  const config = {
    get: vi.fn().mockReturnValue(undefined),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peanpe as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wipay as any,
  );

  return { controller, genericAdapter, wipay, gateways, prisma, queue, metrics, peanpe };
}

function fakeWipayRequest(body: Record<string, string> = { Num_operacion: 'op-test-1', Firma: 'abc' }): FastifyRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    headers: {},
    body,
  } as any;
}

describe('WebhooksController.receive — provider validation (genérico)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown providers with 400', async () => {
    const { controller } = makeController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('GOOGLEPAY', fakeReq)).rejects.toThrow(BadRequestException);
  });

  it('rejects PAYTEF on generic endpoint (uses secret path route)', async () => {
    const { controller } = makeController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('paytef', fakeReq)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects PEANPE on generic endpoint (uses challenge-response route)', async () => {
    const { controller } = makeController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('peanpe', fakeReq)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects WIPAY on generic endpoint (uses /webhooks/wipay dedicated route)', async () => {
    const { controller } = makeController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('wipay', fakeReq)).rejects.toThrow(UnauthorizedException);
  });
});

describe('WebhooksController.receiveWipay — Cecabank form POST', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devuelve $*$OKY$*$ cuando firma válida y nuevo evento', async () => {
    const { controller, prisma, queue, metrics } = makeController();
    const result = await controller.receiveWipay(fakeWipayRequest());
    expect(result).toBe('$*$OKY$*$');
    expect(prisma.webhookDelivery.create).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'valid',
    });
  });

  it('devuelve $*$NOK$*$ cuando firma inválida', async () => {
    const { controller, queue, metrics } = makeController({
      verifyResult: { valid: false, reason: 'signature-mismatch' },
    });
    const result = await controller.receiveWipay(fakeWipayRequest());
    expect(result).toBe('$*$NOK$*$');
    expect(queue.add).not.toHaveBeenCalled();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'invalid',
    });
  });

  it('devuelve $*$NOK$*$ cuando falta externalEventId', async () => {
    const { controller, queue } = makeController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyResult: { valid: true, externalEventId: '', paymentRef: 'x' } as any,
    });
    const result = await controller.receiveWipay(fakeWipayRequest());
    expect(result).toBe('$*$NOK$*$');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('devuelve $*$OKY$*$ y skip queue cuando delivery ya procesado (idempotency)', async () => {
    const { controller, queue, metrics } = makeController({
      existingDelivery: { id: BigInt(99), processedAt: new Date() },
    });
    const result = await controller.receiveWipay(fakeWipayRequest());
    expect(result).toBe('$*$OKY$*$');
    expect(queue.add).not.toHaveBeenCalled();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'WIPAY',
      outcome: 'duplicate',
    });
  });

  it('reusa delivery row si existe pero aún no procesado', async () => {
    const existing = { id: BigInt(99), processedAt: null };
    const { controller, prisma, queue } = makeController({ existingDelivery: existing });
    const result = await controller.receiveWipay(fakeWipayRequest());
    expect(result).toBe('$*$OKY$*$');
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '99' },
      expect.objectContaining({ jobId: 'webhook-WIPAY-op-test-1' }),
    );
  });

  it('usa jobId determinístico (provider, Num_operacion) para idempotency BullMQ', async () => {
    const { controller, queue } = makeController({
      verifyResult: { valid: true, externalEventId: 'unique-op-77', paymentRef: 'unique-op-77' },
    });
    await controller.receiveWipay(fakeWipayRequest());
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      expect.any(Object),
      expect.objectContaining({ jobId: 'webhook-WIPAY-unique-op-77' }),
    );
  });

  it('configura retries con backoff exponencial', async () => {
    const { controller, queue } = makeController();
    await controller.receiveWipay(fakeWipayRequest());
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
