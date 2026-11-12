import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';

/**
 * El arranque: todos los módulos de la API (con BtcpayModule dentro de
 * AppModule y de QueuesModule) se resuelven sin ciclos ni inyecciones que
 * falten, con el pago con bitcoin apagado (lo normal) y encendido. No conecta a
 * ninguna base ni a Redis: solo monta el grafo de inyección.
 */
const ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://np_app:np_app@localhost:1/nightpay',
  REDIS_URL: 'redis://localhost:1',
  JWT_SECRET: 'x'.repeat(40),
  COOKIE_SECRET: 'y'.repeat(40),
  ENCRYPTION_KEK: 'clave-del-servidor-para-las-pruebas-0123456789',
  PEANPE_API_URL: 'http://localhost:1',
  PEANPE_WEBHOOK_SECRET: 'z'.repeat(40),
  NEXT_PUBLIC_API_URL: 'https://api.oxio.test',
  CORS_ORIGINS: 'https://admin.oxio.test',
};

describe('arranque con BtcpayModule', () => {
  const before = { ...process.env };
  afterAll(() => {
    process.env = before;
  });

  it.each(['false', 'true'])('BTCPAY_ENABLED=%s: el grafo de inyección se resuelve', async (flag) => {
    Object.assign(process.env, ENV, { BTCPAY_ENABLED: flag });
    const { AppModule } = await import('../../app.module');
    const { BtcpayInvoiceService } = await import('./btcpay-invoice.service');
    const { WebhookIngestProcessor } = await import('../queues/webhook-ingest.processor');
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      expect(ref.get(BtcpayInvoiceService, { strict: false })).toBeDefined();
      expect(ref.get(WebhookIngestProcessor, { strict: false })).toBeDefined();
    } finally {
      await ref.close();
    }
  }, 120_000);
});
