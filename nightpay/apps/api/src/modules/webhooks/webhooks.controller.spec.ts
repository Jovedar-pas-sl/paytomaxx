import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma } from '@nightpay/db';
import { WebhooksController, sameSecret } from './webhooks.controller';

interface MakeOptions {
  verifyResult?:
    | { valid: true; externalEventId: string; paymentRef: string }
    | { valid: false; reason: string };
  existingDelivery?: { id: bigint; processedAt: Date | null } | null;
  // C2: simula cuántos intentos lleva el rate-limit Redis al peanpe/notify GET.
  // Si > MAX (5) el controller devuelve 429 sin consultar el adapter.
  peanpeNotifyAttempts?: number;
  // Redsys: pago encontrado por (provider, providerTxId = Ds_Order).
  redsysPayment?: { id: string; tenantId: string } | null;
  // Redsys: intento encontrado en payment_attempts (Fase 0).
  redsysAttempt?: { paymentId: string; tenantId: string } | null;
  // Redsys: lo que devuelve parseNotification del aviso.
  redsysNotification?: Record<string, unknown> | null;
  // Trabajo que ya hay en la cola con el id del aviso (P5).
  existingJob?: { failed: boolean; removeError?: Error } | null;
  // Error al guardar el aviso (P10: P2002 si otra entrega lo guardó a la vez).
  createError?: unknown;
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
    verifyWebhook: vi.fn().mockReturnValue(
      opts.verifyResult ?? {
        valid: true,
        externalEventId: 'a1b2c3d4e5f6-0000',
        paymentRef: 'a1b2c3d4e5f6',
      },
    ),
    extractTokenizationData: vi.fn().mockReturnValue(null),
    parseNotification: vi.fn().mockReturnValue(
      opts.redsysNotification === undefined
        ? {
            order: 'a1b2c3d4e5f6',
            response: '0000',
            transactionType: '0',
            approved: true,
            payMethodCode: '78',
            cardBrand: '1',
            cardType: 'D',
            cardCountry: '724',
            cardLast4: '0003',
            authCode: '123456',
            secure3ds: true,
          }
        : opts.redsysNotification,
    ),
  };

  const peanpe = {
    getSecurityTokenForCall: vi.fn(),
    resolvePaymentFromCallback: vi.fn(),
    persistCallbackResult: vi.fn(),
    verifyWebhook: vi.fn(),
  };

  const paymentTx = {
    paymentAttempt: {
      findUnique: vi.fn().mockResolvedValue(opts.redsysAttempt ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    payment: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi
        .fn()
        .mockResolvedValue(
          opts.redsysPayment === undefined
            ? { id: 'pay-uuid-1', tenantId: 'tenant-uuid-1' }
            : opts.redsysPayment,
        ),
    },
  };
  const prisma = {
    asSystem: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(paymentTx)),
    $executeRaw: vi.fn().mockResolvedValue(0),
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(opts.existingDelivery ?? null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.createError) throw opts.createError;
        return { id: BigInt(42), processedAt: null, ...data };
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: BigInt(77) }),
    },
  };

  const job = opts.existingJob
    ? {
        isFailed: vi.fn().mockResolvedValue(opts.existingJob.failed),
        remove: opts.existingJob.removeError
          ? vi.fn().mockRejectedValue(opts.existingJob.removeError)
          : vi.fn().mockResolvedValue(undefined),
      }
    : null;
  const queue = { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(job ?? undefined) };

  const metrics = {
    webhooksReceived: { inc: vi.fn() },
    duplicateCharges: { inc: vi.fn() },
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
    prisma as any,
    gateways as any,
    queue as any,
    metrics as any,
    config as any,
    redis as any,
    peanpe as any,
    wipay as any,
    redsys as any,
  );

  return { controller, genericAdapter, wipay, redsys, gateways, prisma, paymentTx, queue, job, metrics, peanpe, redis, config };
}

function fakeWipayRequest(body: Record<string, string> = { Num_operacion: 'op-test-1', Firma: 'abc' }): FastifyRequest {
  return {
    headers: {},
    body,
  } as any;
}

describe('WebhooksController.receive — provider validation (genérico)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown providers with 400', async () => {
    const { controller } = makeController();
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('GOOGLEPAY', fakeReq)).rejects.toThrow(BadRequestException);
  });

  it('rejects PAYTEF on generic endpoint (uses secret path route)', async () => {
    const { controller } = makeController();
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('paytef', fakeReq)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects PEANPE on generic endpoint (uses challenge-response route)', async () => {
    const { controller } = makeController();
    const fakeReq = { headers: {}, body: {} } as any;
    await expect(controller.receive('peanpe', fakeReq)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects WIPAY on generic endpoint (uses /webhooks/wipay dedicated route)', async () => {
    const { controller } = makeController();
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

describe('WebhooksController.receiveRedsys — resolución Ds_Order → payment', () => {
  function fakeRedsysRequest(): FastifyRequest {
    return {
      headers: {},
      body: {
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: 'eyJ9',
        Ds_Signature: 'sig',
      },
    } as any;
  }

  it('busca el payment por (REDSYS, Ds_Order) y guarda tenantId + _paymentId', async () => {
    const { controller, prisma, paymentTx, queue } = makeController();

    await controller.receiveRedsys(fakeRedsysRequest());

    expect(paymentTx.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: 'REDSYS', providerTxId: 'a1b2c3d4e5f6' },
      }),
    );
    const data = prisma.webhookDelivery.create.mock.calls[0]![0].data as {
      tenantId: string;
      externalEventId: string;
      rawBody: Buffer;
    };
    expect(data.tenantId).toBe('tenant-uuid-1');
    expect(data.externalEventId).toBe('a1b2c3d4e5f6-0000');
    expect(data.rawBody.toString('utf8')).toContain('_paymentId=pay-uuid-1');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('pedido desconocido: guarda el aviso sin _paymentId (auditoría) y responde 200', async () => {
    const { controller, prisma } = makeController({ redsysPayment: null });

    const res = await controller.receiveRedsys(fakeRedsysRequest());

    expect(res).toEqual({ received: true });
    const data = prisma.webhookDelivery.create.mock.calls[0]![0].data as {
      tenantId?: string;
      rawBody: Buffer;
    };
    expect(data.tenantId).toBeUndefined();
    expect(data.rawBody.toString('utf8')).not.toContain('_paymentId');
  });

  it('descarta un _paymentId enviado por el cliente (fuera de la firma)', async () => {
    const { controller, prisma } = makeController({ redsysPayment: null });
    const req = fakeRedsysRequest();
    (req.body as Record<string, string>)._paymentId = 'victim-payment-uuid';

    await controller.receiveRedsys(req);

    const data = prisma.webhookDelivery.create.mock.calls[0]![0].data as { rawBody: Buffer };
    expect(data.rawBody.toString('utf8')).not.toContain('victim-payment-uuid');
  });

  it('firma inválida → 401 y no consulta la DB', async () => {
    const { controller, paymentTx } = makeController({
      verifyResult: { valid: false, reason: 'signature-mismatch' },
    });

    await expect(controller.receiveRedsys(fakeRedsysRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(paymentTx.payment.findFirst).not.toHaveBeenCalled();
  });

  it('resuelve el pago por su intento (payment_attempts) aunque no sea el último', async () => {
    const { controller, prisma, paymentTx } = makeController({
      redsysAttempt: { paymentId: 'pay-from-attempt', tenantId: 'tenant-2' },
    });

    await controller.receiveRedsys(fakeRedsysRequest());

    expect(paymentTx.payment.findFirst).not.toHaveBeenCalled();
    const data = prisma.webhookDelivery.create.mock.calls[0]![0].data as {
      tenantId: string;
      rawBody: Buffer;
    };
    expect(data.tenantId).toBe('tenant-2');
    expect(data.rawBody.toString('utf8')).toContain('_paymentId=pay-from-attempt');
  });

  it('aviso aprobado: intento APPROVED y guarda método, tarjeta y autorización', async () => {
    const { controller, paymentTx } = makeController();

    await controller.receiveRedsys(fakeRedsysRequest());

    expect(paymentTx.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: { provider: 'REDSYS', providerTxId: 'a1b2c3d4e5f6' },
      data: { status: 'APPROVED', responseCode: '0000' },
    });
    const update = paymentTx.payment.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: 'pay-uuid-1', authorizedAt: null });
    expect(update.data).toMatchObject({
      payMethodCode: '78',
      cardLast4: '0003',
      cardCountry: '724',
      authCode: '123456',
      secure3ds: true,
    });
    // #24: la hora de pago la pone transition() al pasar a AUTHORIZED, no la
    // llegada del aviso (que aún puede no darse por bueno).
    expect(update.data).not.toHaveProperty('authorizedAt');
  });

  it('aviso denegado: intento DENIED y no toca el pago', async () => {
    const { controller, paymentTx } = makeController({
      redsysNotification: {
        order: 'a1b2c3d4e5f6',
        response: '0190',
        transactionType: '0',
        approved: false,
      },
    });

    await controller.receiveRedsys(fakeRedsysRequest());

    // P7: un KO tardío no pisa un intento que el banco ya aprobó.
    expect(paymentTx.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: { provider: 'REDSYS', providerTxId: 'a1b2c3d4e5f6', status: { not: 'APPROVED' } },
      data: { status: 'DENIED', responseCode: '0190' },
    });
    expect(paymentTx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('P1: el doble cobro no se cuenta aquí sin candado (lo apunta transition al procesar el aviso)', async () => {
    const { controller, paymentTx, metrics } = makeController();

    await controller.receiveRedsys(fakeRedsysRequest());

    expect(paymentTx.paymentAttempt.count).not.toHaveBeenCalled();
    expect(metrics.duplicateCharges.inc).not.toHaveBeenCalled();
    expect(paymentTx.paymentEvent.create).not.toHaveBeenCalled();
  });
});

describe('WebhooksController — aviso que agotó los reintentos (P5) y entregas a la vez (P10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reenvío de un aviso cuyo trabajo falló: se quita el fallido y se vuelve a encolar', async () => {
    const { controller, queue, job } = makeController({
      existingDelivery: { id: BigInt(5), processedAt: null },
      existingJob: { failed: true },
    });

    await expect(controller.receiveWipay(fakeWipayRequest())).resolves.toBe('$*$OKY$*$');

    expect(queue.getJob).toHaveBeenCalledWith('webhook-WIPAY-op-test-1');
    expect(job!.remove).toHaveBeenCalledTimes(1);
    expect(job!.remove.mock.invocationCallOrder[0]!).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    expect(queue.add).toHaveBeenCalledWith('process-webhook', { deliveryId: '5' }, expect.objectContaining({ jobId: 'webhook-WIPAY-op-test-1' }));
  });

  it('trabajo aún en cola o en curso: no se toca (add con el mismo id no lo duplica)', async () => {
    const { controller, queue, job } = makeController({ existingJob: { failed: false } });

    await controller.receiveWipay(fakeWipayRequest());

    expect(job!.remove).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('si otra entrega ya quitó el fallido, se encola igual', async () => {
    const { controller, queue } = makeController({ existingJob: { failed: true, removeError: new Error('Missing key') } });

    await expect(controller.receiveWipay(fakeWipayRequest())).resolves.toBe('$*$OKY$*$');

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('el mismo aviso guardado a la vez por otra entrega (P2002): usa ese registro, sin 500', async () => {
    const clash = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    const { controller, prisma, queue } = makeController({ createError: clash });

    await expect(controller.receiveWipay(fakeWipayRequest())).resolves.toBe('$*$OKY$*$');

    expect(prisma.webhookDelivery.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { provider_externalEventId: { provider: 'WIPAY', externalEventId: 'op-test-1' } },
      select: { id: true },
    });
    expect(queue.add).toHaveBeenCalledWith('process-webhook', { deliveryId: '77' }, expect.anything());
  });

  it('otro error al guardar el aviso no se esconde', async () => {
    const { controller, prisma } = makeController({ createError: new Error('db caída') });

    await expect(controller.receiveWipay(fakeWipayRequest())).rejects.toThrow('db caída');
    expect(prisma.webhookDelivery.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('WebhooksController.receivePaytef — URL secreta', () => {
  const SECRET = 'paytef-url-secret-0123456789abcdef';
  function paytefController() {
    const made = makeController({ verifyResult: { valid: true, externalEventId: 'pl-1_t-1', paymentRef: 'pay-uuid' } });
    made.config.get = vi.fn().mockImplementation((k: string) => (k === 'PAYTEF_WEBHOOK_SECRET' ? SECRET : undefined));
    return made;
  }
  const req = { headers: {}, body: {} } as any;

  it('sameSecret: igual → sí; distinto (o de otra longitud) → no', () => {
    expect(sameSecret(SECRET, SECRET)).toBe(true);
    expect(sameSecret(`${SECRET}x`, SECRET)).toBe(false);
    expect(sameSecret(SECRET.replace(/f$/, 'e'), SECRET)).toBe(false);
    expect(sameSecret('', SECRET)).toBe(false);
  });

  it('secreto incorrecto → 401 y no se guarda nada', async () => {
    const { controller, prisma, queue } = paytefController();
    await expect(controller.receivePaytef('otro-secreto', req)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('secreto correcto → se guarda y se encola (el procesador lo comprobará con Paytef)', async () => {
    const { controller, queue } = paytefController();
    await expect(controller.receivePaytef(SECRET, req)).resolves.toEqual({ received: true });
    expect(queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '42' },
      expect.objectContaining({ jobId: 'webhook-PAYTEF-pl-1_t-1' }),
    );
  });
});
