import Fastify from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_TARGET = process.env.WEBHOOK_TARGET ?? 'http://localhost:3000/v1/webhooks/wipay';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'dev_wipay_secret';

const app = Fastify({ logger: true });

app.get('/health', () => ({ status: 'ok', service: 'mock-wipay' }));

app.post<{ Body: { reference: string; amount: number; currency?: string } }>(
  '/v1/authorize',
  async (req, reply) => {
    const { reference, amount } = req.body;
    const transactionId = `WPY-${randomUUID()}`;

    reply.code(202).send({
      transaction_id: transactionId,
      status: 'PROCESSING',
      reference,
    });

    // Simula autorización asíncrona: envía webhook en 500ms-2s (jitter realista)
    const delay = 500 + Math.random() * 1500;
    setTimeout(() => void sendWebhook(transactionId, reference, amount, 'payment.authorized'), delay);
  },
);

app.get<{ Params: { id: string } }>('/v1/transactions/:id', async (req) => {
  return {
    transaction_id: req.params.id,
    status: 'AUTHORIZED',
    timestamp: new Date().toISOString(),
  };
});

app.post<{
  Params: { id: string };
  Body: { amount: number; reason?: string };
}>('/v1/transactions/:id/refund', async (req) => {
  // Mock: siempre acepta, status SUCCEEDED inmediato
  return {
    refund_id: `WPY-RF-${randomUUID()}`,
    transaction_id: req.params.id,
    amount: req.body.amount,
    status: 'SUCCEEDED',
    timestamp: new Date().toISOString(),
  };
});

async function sendWebhook(
  txId: string,
  reference: string,
  amount: number,
  eventType: string,
): Promise<void> {
  const payload = {
    event_id: `evt_${randomUUID()}`,
    event_type: eventType,
    transaction_id: txId,
    reference,
    merchant_id: 'MERCHANT_DEV',
    amount,
    currency: 'EUR',
    timestamp: Date.now(),
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  try {
    const res = await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': timestamp,
      },
      body: rawBody,
    });
    app.log.info({ txId, status: res.status }, 'webhook delivered');
  } catch (err) {
    app.log.error({ err, txId }, 'webhook delivery failed');
  }
}

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`mock-wipay listening on :${PORT} → webhooks to ${WEBHOOK_TARGET}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
