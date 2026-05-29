import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WebhooksController } from './webhooks.controller';

interface MakeOptions {
  verifyResult?:
    | { valid: true; externalEventId: string; paymentRef: string }
    | { valid: false; reason: string };
  existingDelivery?: { id: bigint; processedAt: Date | null } | null;
  // C2: simula cuántos intentos lleva el rate-limit Redis al peanpe/notify GET.
  // Si > MAX (5) el controller devuelve 429 sin consultar el adapter.
  peanpeNotifyAttempts?: number;
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

  // Redsys adapter (mock — el controller lo inyecta aunque solo se use en
  // su ruta dedicada). Las pruebas aquí no ejercen receiveRedsys, basta con
  // que el constructor no falle.
  const redsys = {
    verifyWebhook: vi.fn(),
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

  // C2: cliente Redis mock — el rate-limiter usa EVAL atómico (obs #3 review).
  // El script Lua devuelve el contador actualizado tras INCR + EXPIRE.
  const redis = {
    eval: vi.fn().mockResolvedValue(opts.peanpeNotifyAttempts ?? 1),
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
    redis as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peanpe as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wipay as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redsys as any,
  );

  return { controller, genericAdapter, wipay, redsys, gateways, prisma, queue, metrics, peanpe, redis };
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

describe('WebhooksController.peanpeResult — C2 rate-limit anti brute-force', () => {
  beforeEach(() => vi.clearAllMocks());

  it('llama EVAL Lua atómico con key + window (obs #3)', async () => {
    const { controller, redis, peanpe } = makeController({ peanpeNotifyAttempts: 1 });
    peanpe.resolvePaymentFromCallback.mockResolvedValue(null);
    await expect(
      controller.peanpeResult('ABC123', '1234567890', '200', undefined, undefined, undefined),
    ).rejects.toThrow(UnauthorizedException);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'peanpe:notify-attempts:ABC123',
      '60',
    );
  });

  it('429 cuando se supera el límite (max 5/min) y NO consulta adapter (no timing oracle)', async () => {
    const { controller, peanpe, metrics } = makeController({ peanpeNotifyAttempts: 6 });
    await expect(
      controller.peanpeResult('ABC123', '1234567890', '200', undefined, undefined, undefined),
    ).rejects.toThrow(HttpException);
    expect(peanpe.resolvePaymentFromCallback).not.toHaveBeenCalled();
    expect(metrics.webhooksReceived.inc).toHaveBeenCalledWith({
      provider: 'PEANPE',
      outcome: 'invalid',
    });
  });

  it('400 si faltan query params obligatorios (antes de rate-limit)', async () => {
    const { controller, redis } = makeController();
    await expect(
      controller.peanpeResult(undefined, '1234567890', '200', undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);
    // Rate-limit no se evalúa si los params faltan → no EVAL
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
