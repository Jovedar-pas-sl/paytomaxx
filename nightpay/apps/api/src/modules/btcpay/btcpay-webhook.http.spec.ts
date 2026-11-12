import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { BtcpayWebhookController } from './btcpay-webhook.controller';
import { BtcpayStoreService } from './btcpay-store.service';

/**
 * El aviso de BTCPay por HTTP de verdad (Fastify con rawBody, como main.ts):
 * la firma se comprueba sobre los BYTES recibidos, con espacios, saltos de línea
 * y tildes tal cual los manda BTCPay; el JSON vuelto a escribir no valdría.
 */
const SECRET = 'secreto-del-aviso-de-prueba-0123456789';
const TOKEN = 'token-del-local-0123456789abcdef';
const access = { tenantId: 't-1', storeId: 'ST1', webhookSecret: SECRET, hookToken: TOKEN, origin: 'https://x.es', apiKey: 'k', enabled: true, purpose: 'BOTH' };

const prisma = {
  webhookDelivery: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: 7n })),
    findUniqueOrThrow: vi.fn(),
  },
};
const queue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => null) };
const metrics = { webhooksReceived: { inc: vi.fn() } };
const stores = { accessByHookToken: vi.fn(async (t: string) => (t === TOKEN ? access : null)) };

let app: NestFastifyApplication;
const before = process.env.BTCPAY_ENABLED;

beforeAll(async () => {
  process.env.BTCPAY_ENABLED = 'true';
  const ref = await Test.createTestingModule({
    controllers: [BtcpayWebhookController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: BtcpayStoreService, useValue: stores },
      { provide: MetricsService, useValue: metrics },
      { provide: getQueueToken(WEBHOOKS_INGEST_QUEUE), useValue: queue },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  if (before === undefined) delete process.env.BTCPAY_ENABLED;
  else process.env.BTCPAY_ENABLED = before;
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.webhookDelivery.findUnique.mockResolvedValue(null);
  prisma.webhookDelivery.create.mockResolvedValue({ id: 7n });
});

const sign = (body: string | Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
// Con espacios raros, saltos de línea, orden poco habitual y una tilde: lo que un JSON reescrito cambiaría.
const BODY = '{ "type" : "InvoiceSettled",\n  "deliveryId":"d-1", "originalDeliveryId" : "o-1",\n"storeId":"ST1","invoiceId":"INV1","metadata":{"orderId":"cobro-ñ"} }';

const post = (token: string, payload: string, sig?: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/webhooks/btcpay/${token}`,
    headers: { 'content-type': 'application/json', ...(sig ? { 'btcpay-sig': sig } : {}) },
    payload,
  });

describe('POST /v1/webhooks/btcpay/:hookToken', () => {
  it('firma buena sobre el cuerpo tal cual → 200, guardado y a la cola', async () => {
    const res = await post(TOKEN, BODY, sign(BODY));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provider: 'BTCPAY', externalEventId: 't-1:o-1', tenantId: 't-1' }),
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('el cuerpo guardado es el recibido, byte a byte', async () => {
    await post(TOKEN, BODY, sign(BODY));
    const saved = (prisma.webhookDelivery.create.mock.calls[0] as unknown as [{ data: { rawBody: Buffer } }])[0].data.rawBody;
    expect(Buffer.isBuffer(saved)).toBe(true);
    expect(saved.toString('utf8')).toBe(BODY);
  });

  it('firma de otro cuerpo, secreto equivocado o sin cabecera → 401 sin guardar ni encolar', async () => {
    for (const sig of [sign(BODY.replace('INV1', 'INV2')), sign(BODY, 'otro-secreto'), undefined, 'sha256=zz', sign(JSON.stringify(JSON.parse(BODY)))]) {
      const res = await post(TOKEN, BODY, sig);
      expect(res.statusCode).toBe(401);
    }
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('token desconocido → 404', async () => {
    expect((await post('token-que-no-existe-0123456789', BODY, sign(BODY))).statusCode).toBe(404);
  });

  it('un tipo que no se usa → 200 y no se guarda', async () => {
    const body = BODY.replace('InvoiceSettled', 'InvoiceCreated');
    const res = await post(TOKEN, body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: 'type' });
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('un reenvío ya procesado → 200 «duplicate» sin encolar otra vez', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ id: 7n, processedAt: new Date() } as never);
    const res = await post(TOKEN, BODY, sign(BODY));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un fallo nuestro y pasajero (la cola no responde) → 503, para que BTCPay reintente', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis caído'));
    const res = await post(TOKEN, BODY, sign(BODY));
    expect(res.statusCode).toBe(503);
  });

  it('con el interruptor del servidor apagado la ruta no existe (404)', async () => {
    process.env.BTCPAY_ENABLED = 'false';
    try {
      expect((await post(TOKEN, BODY, sign(BODY))).statusCode).toBe(404);
    } finally {
      process.env.BTCPAY_ENABLED = 'true';
    }
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
