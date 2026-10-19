import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { WebhooksController } from './webhooks.controller';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { openTokenizationData } from '../payments/tokenization-seal';

// Credenciales PÚBLICAS de pruebas de Redsys (comercio de test de su documentación).
const MERCHANT = '999008881';
const KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const KEK = 'kek-de-pruebas-0123456789abcdef0123456789';

// Cobro en "Sala Apolo" (Barcelona).
const PAYMENT_ID = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TENANT_ID = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const DS_ORDER = '2610170002CD';
const NOW = new Date('2026-10-17T02:15:00Z');

interface Options {
  existing?: { id: bigint; processedAt: Date | null } | null;
  /** Intento encontrado por Ds_Order (null = pedido desconocido). */
  attempt?: { paymentId: string; tenantId: string } | null;
}

function makeHarness(o: Options = {}) {
  const metrics = {
    webhooksReceived: { inc: vi.fn() },
    duplicateCharges: { inc: vi.fn() },
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  const env: Record<string, string | number> = {
    GATEWAY_TIMEOUT_MS: 5000,
    REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
    REDSYS_MERCHANT_CODE: MERCHANT,
    REDSYS_TERMINAL: '1',
    REDSYS_SECRET_KEY: KEY,
  };
  const config = { get: vi.fn((k: string) => env[k]) };
  const tx = {
    paymentAttempt: {
      findUnique: vi
        .fn()
        .mockResolvedValue(o.attempt === undefined ? { paymentId: PAYMENT_ID, tenantId: TENANT_ID } : o.attempt),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    payment: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(o.existing ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: BigInt(640), processedAt: null, ...data })),
    },
  };
  const redsys = new RedsysAdapter(config as never, metrics as never);
  const queue = { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(undefined) };
  const controller = new WebhooksController(
    prisma as never, { get: vi.fn() } as never, queue as never, metrics as never,
    config as never, { eval: vi.fn() } as never, {} as never, {} as never, redsys,
  );
  return { controller, prisma, tx, queue, metrics, redsys };
}

/** Body ya parseado por Fastify: aviso firmado con la clave del comercio. */
function notice(fields: Record<string, string> = {}): FastifyRequest {
  const params = {
    Ds_Order: DS_ORDER,
    Ds_MerchantCode: MERCHANT,
    Ds_Response: '0000',
    Ds_TransactionType: '0',
    Ds_Amount: '4850',
    Ds_Currency: '978',
    Ds_Card_Number: '454881******0003',
    Ds_Card_Brand: '1',
    ...fields,
  };
  const s = serializeAndSignJSONRequest(KEY, { Ds_Merchant_Order: params.Ds_Order, ...params } as never);
  const body = {
    Ds_SignatureVersion: s.Ds_SignatureVersion,
    Ds_MerchantParameters: s.Ds_MerchantParameters,
    Ds_Signature: s.Ds_Signature,
  };
  return { headers: {}, body } as unknown as FastifyRequest;
}

const TOKEN_FIELDS = { Ds_Merchant_Identifier: 'tok-8812734455aa', Ds_ExpiryDate: '2912' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('receiveRedsys — idempotencia', () => {
  it('aviso válido sin id de evento → 400, métrica invalid y nada guardado', async () => {
    const h = makeHarness();
    vi.spyOn(h.redsys, 'verifyWebhook').mockReturnValue({ valid: true, paymentRef: DS_ORDER });
    await expect(h.controller.receiveRedsys(notice())).rejects.toBeInstanceOf(BadRequestException);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'invalid' });
    expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('aviso ya procesado → duplicate, sin tocar intentos, cobro ni cola', async () => {
    const h = makeHarness({ existing: { id: BigInt(88), processedAt: new Date('2026-10-17T02:12:00Z') } });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true, duplicate: true });
    expect(h.prisma.webhookDelivery.findUnique).toHaveBeenCalledWith({
      where: { provider_externalEventId: { provider: 'REDSYS', externalEventId: `${DS_ORDER}-0000` } },
    });
    expect(h.prisma.asSystem).not.toHaveBeenCalled();
    expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'duplicate' });
  });

  it('aviso guardado sin procesar → reusa el registro y reencola con el mismo jobId', async () => {
    const h = makeHarness({ existing: { id: BigInt(88), processedAt: null } });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '88' },
      { jobId: `webhook-REDSYS-${DS_ORDER}-0000`, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
  });

  it('un KO y el OK posterior del mismo pedido son avisos distintos (intento DENIED y luego APPROVED)', async () => {
    const h = makeHarness();
    await h.controller.receiveRedsys(notice({ Ds_Response: '0190' }));
    await h.controller.receiveRedsys(notice());
    expect(h.prisma.webhookDelivery.create.mock.calls.map((c) => c[0].data.externalEventId)).toEqual([
      `${DS_ORDER}-0190`,
      `${DS_ORDER}-0000`,
    ]);
    expect(h.tx.paymentAttempt.updateMany.mock.calls.map((c) => c[0].data)).toEqual([
      { status: 'DENIED', responseCode: '0190' },
      { status: 'APPROVED', responseCode: '0000' },
    ]);
    // La denegación no toca los datos de tarjeta del cobro; la aprobación sí.
    expect(h.tx.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('aviso de devolución (tipo 3, 0900) del pedido → se guarda pero no cambia el intento', async () => {
    const h = makeHarness();
    await h.controller.receiveRedsys(notice({ Ds_Response: '0900', Ds_TransactionType: '3' }));
    expect(h.tx.paymentAttempt.updateMany).not.toHaveBeenCalled();
    expect(h.tx.payment.updateMany).not.toHaveBeenCalled();
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });

  it('si falla anotar el resultado del intento, el aviso se encola igual', async () => {
    const h = makeHarness();
    h.tx.paymentAttempt.updateMany.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'valid' });
  });
});

describe('receiveRedsys — captura del token de tarjeta', () => {
  it('con ENCRYPTION_KEK → guarda el token cifrado (sin el identificador en claro) en el cobro resuelto', async () => {
    vi.stubEnv('ENCRYPTION_KEK', KEK);
    const h = makeHarness();

    await h.controller.receiveRedsys(notice(TOKEN_FIELDS));

    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, sealedJson, paymentId] = h.tx.$executeRaw.mock.calls[0]! as [TemplateStringsArray, string, string];
    expect(sql.join('?')).toMatch(/"tokenizationData" IS NULL/);
    expect(paymentId).toBe(PAYMENT_ID);
    expect(sealedJson).not.toContain(TOKEN_FIELDS.Ds_Merchant_Identifier);
    const sealed = JSON.parse(sealedJson) as Record<string, unknown>;
    expect(sealed).toMatchObject({ v: 1, cardLast4: '0003', expiry: '2912', capturedAt: NOW.toISOString() });
    expect(openTokenizationData(sealed, KEK)).toMatchObject({
      identifier: TOKEN_FIELDS.Ds_Merchant_Identifier,
      cofTxnId: DS_ORDER,
    });
  });

  it('sin ENCRYPTION_KEK → no guarda el token pero el aviso sigue (se encola y responde 200)', async () => {
    vi.stubEnv('ENCRYPTION_KEK', '');
    const h = makeHarness();
    await expect(h.controller.receiveRedsys(notice(TOKEN_FIELDS))).resolves.toEqual({ received: true });
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });

  it('pedido sin cobro asociado → el token no se guarda en ningún cobro', async () => {
    vi.stubEnv('ENCRYPTION_KEK', KEK);
    const h = makeHarness({ attempt: null });
    await expect(h.controller.receiveRedsys(notice(TOKEN_FIELDS))).resolves.toEqual({ received: true });
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expect(h.prisma.webhookDelivery.create.mock.calls[0]![0].data).not.toHaveProperty('tenantId');
  });

  it('aviso denegado con identificador → no se captura token', async () => {
    vi.stubEnv('ENCRYPTION_KEK', KEK);
    const h = makeHarness();
    await h.controller.receiveRedsys(notice({ ...TOKEN_FIELDS, Ds_Response: '0190' }));
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });
});
