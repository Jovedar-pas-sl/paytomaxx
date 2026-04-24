import Fastify from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_TARGET = process.env.WEBHOOK_TARGET ?? 'http://localhost:3000/v1/webhooks/peanpe';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'dev_peanpe_secret';

const app = Fastify({ logger: true });

app.get('/health', () => ({ status: 'ok', service: 'mock-peanpe' }));

app.post<{ Body: { externalRef: string; amountCents: number; venueId: string } }>(
  '/payments',
  async (req, reply) => {
    const { externalRef, amountCents, venueId } = req.body;
    const providerTxId = `PEANPE-${randomUUID()}`;

    reply.code(202).send({
      id: providerTxId,
      status: 'processing',
      externalRef,
    });

    // Simula autorización asíncrona
    const delay = 500 + Math.random() * 1500;
    setTimeout(
      () => void sendWebhook(providerTxId, externalRef, amountCents, venueId, 'payment.authorized'),
      delay,
    );
  },
);

app.get<{ Params: { id: string } }>('/payments/:id', async (req) => {
  return {
    id: req.params.id,
    state: 'authorized',
    ts: new Date().toISOString(),
  };
});

async function sendWebhook(
  providerTxId: string,
  externalRef: string,
  amountCents: number,
  venueId: string,
  eventType: string,
): Promise<void> {
  const payload = {
    id: `evt_${randomUUID()}`,
    type: eventType,
    providerTxId,
    externalRef,
    venueId,
    amountCents,
    ts: new Date().toISOString(),
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
    app.log.info({ providerTxId, status: res.status }, 'webhook delivered');
  } catch (err) {
    app.log.error({ err, providerTxId }, 'webhook delivery failed');
  }
}

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`mock-peanpe listening on :${PORT} → webhooks to ${WEBHOOK_TARGET}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
