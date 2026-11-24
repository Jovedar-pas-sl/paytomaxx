import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { Prisma } from '@nightpay/db';
import { WebhooksController } from './webhooks.controller';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { openTokenizationData } from '../payments/tokenization-seal';
import { IP_RATE_LIMIT_META, type IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';

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
  /** El procesador de avisos (en la app, WebhookIngestProcessor): sin él, solo la cola. */
  ingest?: { processDelivery: ReturnType<typeof vi.fn> };
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
      // Ya guardado: el mismo aviso choca con la clave única y se usa ese registro.
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (o.existing) throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        return { id: BigInt(640), processedAt: null, ...data };
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(o.existing ?? null),
    },
  };
  const redsys = new RedsysAdapter(config as never, metrics as never);
  const queue = { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(undefined) };
  const moduleRef = o.ingest ? { get: vi.fn(() => o.ingest) } : undefined;
  const controller = new WebhooksController(
    prisma as never, { get: vi.fn() } as never, queue as never, metrics as never,
    config as never, { eval: vi.fn() } as never, {} as never, {} as never, redsys, undefined, moduleRef as never,
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
    expect(h.prisma.webhookDelivery.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { provider_externalEventId: { provider: 'REDSYS', externalEventId: `${DS_ORDER}-0000` } },
      select: { id: true, processedAt: true },
    });
    expect(h.prisma.asSystem).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'duplicate' });
  });

  it('aviso guardado sin procesar → reusa el registro y reencola con el mismo jobId', async () => {
    const h = makeHarness({ existing: { id: BigInt(88), processedAt: null } });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '88' },
      { jobId: `webhook-REDSYS-${DS_ORDER}-0000`, attempts: 8, backoff: { type: 'exponential', delay: 1000 } },
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

describe('receiveRedsys — el aviso firmado se procesa en la misma petición (carga del 19-11-2026)', () => {
  const ingestThat = (impl: () => Promise<boolean>) => ({ processDelivery: vi.fn(impl) });

  it('caso normal: «Pagado» sin pasar por la cola (4 a la vez y en fila con mucha gente)', async () => {
    const ingest = ingestThat(async () => true);
    const h = makeHarness({ ingest });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(ingest.processDelivery).toHaveBeenCalledWith('640');
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'valid' });
  });

  it('si procesarlo falla (la base sin conexión libre…), a la cola para reintentar y el banco recibe su 200', async () => {
    const ingest = ingestThat(async () => {
      throw new Error('P2028 Unable to start a transaction in the given time');
    });
    const h = makeHarness({ ingest });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(h.queue.add).toHaveBeenCalledWith('process-webhook', { deliveryId: '640' }, expect.objectContaining({ jobId: `webhook-REDSYS-${DS_ORDER}-0000` }));
  });

  it('si otra petición está con el mismo aviso (su candado), a la cola por si aquella no termina', async () => {
    const ingest = ingestThat(async () => false);
    const h = makeHarness({ ingest });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });

  it('un aviso repetido ya procesado no cambia nada: ni se procesa ni se encola', async () => {
    const ingest = ingestThat(async () => true);
    const h = makeHarness({ ingest, existing: { id: BigInt(88), processedAt: new Date('2026-10-17T02:12:00Z') } });
    await expect(h.controller.receiveRedsys(notice())).resolves.toEqual({ received: true, duplicate: true });
    expect(ingest.processDelivery).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('con la base muy lenta, se contesta al banco a los 5 s y el aviso termina aparte (sin cola si sale bien)', async () => {
    vi.useRealTimers(); // la de beforeEach solo finge Date: otra vez, también los temporizadores
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    let finish: (done: boolean) => void = () => undefined;
    const ingest = ingestThat(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const h = makeHarness({ ingest });
    let answered = false;
    const answer = h.controller.receiveRedsys(notice()).finally(() => (answered = true));
    // Hasta que empieza a procesarlo (la base de mentira contesta en microtareas): desde ahí cuentan los 5 s.
    for (let i = 0; i < 1_000 && ingest.processDelivery.mock.calls.length === 0; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ received: true });
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('fuera del límite global (los avisos llegan de pocas IP del banco), con su propio tope por IP, alto', () => {
    const limit = Reflect.getMetadata(IP_RATE_LIMIT_META, WebhooksController.prototype.receiveRedsys) as IpRateLimitConfig;
    expect(limit).toMatchObject({ windowSec: 60, scope: 'webhook-redsys', failOpen: true });
    expect(limit.max).toBeGreaterThanOrEqual(3_000);
  });
});

describe('receiveRedsys — con la base saturada al buscar el cobro (punto 4 de la revisión del 20-11)', () => {
  it('el aviso queda guardado nada más comprobar la firma y se procesa igual (el procesador busca el cobro)', async () => {
    const ingest = { processDelivery: vi.fn(async () => true) };
    const h = makeHarness({ ingest });
    // Sábado 01:30, en pleno pico: el pool no da conexión a tiempo (P2028) al buscar el cobro de 60 €.
    h.prisma.asSystem.mockRejectedValue(new Error('P2028 Unable to start a transaction in the given time'));

    await expect(h.controller.receiveRedsys(notice({ Ds_Amount: '6000' }))).resolves.toEqual({ received: true });

    expect(h.prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.webhookDelivery.create.mock.calls[0]![0].data).toMatchObject({ provider: 'REDSYS', externalEventId: `${DS_ORDER}-0000` });
    expect(ingest.processDelivery).toHaveBeenCalledWith('640');
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

describe('receiveRedsys — cuerpos enormes (SEC-05, zod GHSA-mrhx-c7xc-m3w5)', () => {
  it('100.000 campos que no son texto: se rechaza enseguida como aviso sin firma, sin validarlos uno a uno', async () => {
    const h = makeHarness();
    const body = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, {}]));
    // performance.now: Date está congelado en estas pruebas.
    const started = performance.now();
    await expect(h.controller.receiveRedsys({ headers: {}, body } as unknown as FastifyRequest)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'invalid' });
  });
});
