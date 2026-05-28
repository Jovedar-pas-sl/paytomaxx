import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { createHmac } from 'node:crypto';

/**
 * Mock Peanpe v2.0 — simula el protocolo REAL de peanpe.com para tests E2E.
 *
 * Diferencia con versión anterior (HMAC genérico con X-Signature): aquella
 * NO simulaba el protocolo real. Esta sí.
 *
 * Endpoints simulados:
 *
 *  GET /api?accion=pagar&identificador_cuenta_peanpe=XXX&identificador_llamada=YYY
 *      &cantidad=ZZZ&concepto=...&firma=...[&debug=1]
 *    → Renderiza HTML del "formulario hosted" simulado (auto-submit en 1s).
 *    → Tras el "pago" simulado, dispara el challenge-response a WEBHOOK_TARGET.
 *
 *  Challenge-response simulado:
 *    1. POST WEBHOOK_TARGET con body { identificador_llamada }
 *       → espera respuesta texto plano = securityToken (10 dígitos)
 *    2. GET WEBHOOK_TARGET?identificador_llamada=YYY&seguridad=<token>
 *       &status=200&msg=correcto&accion=pagar&debug=<0|1>
 *
 * Env vars:
 *   PORT (default 3001)
 *   WEBHOOK_TARGET (default http://localhost:4100/v1/webhooks/peanpe/notify)
 *   API_KEY_HEX (default usa el de tests del adapter)
 *   ACCOUNT_ID (default '91816')
 *   SIMULATE_FAILURE_STATUS (default vacío — si set, ej '101', simula esa
 *     respuesta en lugar de 200)
 *   PAYMENT_DELAY_MS (default 500 — delay antes del callback challenge-response)
 */

const PORT = Number(process.env.PORT ?? 3001);
const WEBHOOK_TARGET =
  process.env.WEBHOOK_TARGET ?? 'http://localhost:4100/v1/webhooks/peanpe/notify';
const API_KEY_HEX =
  process.env.API_KEY_HEX ??
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const ACCOUNT_ID = process.env.ACCOUNT_ID ?? '91816';
const SIMULATE_FAILURE_STATUS = process.env.SIMULATE_FAILURE_STATUS ?? '';
const PAYMENT_DELAY_MS = Number(process.env.PAYMENT_DELAY_MS ?? 500);

const app = Fastify({ logger: true });
await app.register(formbody);

app.get('/health', () => ({ status: 'ok', service: 'mock-peanpe', protocol: 'v2.0' }));

/**
 * Simula el formulario hosted de Peanpe. Valida la firma HMAC entrante
 * (igual que peanpe.com real haría) y agenda el callback challenge-response.
 */
app.get('/api', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  const accion = q.accion ?? '';
  const idCuenta = q.identificador_cuenta_peanpe ?? '';
  const idLlamada = q.identificador_llamada ?? '';
  const cantidad = q.cantidad ?? '';
  const firma = q.firma ?? '';
  const debug = q.debug === '1';

  if (accion !== 'pagar') {
    reply.code(400).send({ error: 'accion debe ser "pagar" en v2.0' });
    return;
  }
  if (!idCuenta || !idLlamada || !cantidad || !firma) {
    reply.code(400).send({ error: 'params faltantes' });
    return;
  }
  if (idCuenta !== ACCOUNT_ID) {
    reply.code(401).send({ error: `account mismatch (esperaba ${ACCOUNT_ID})` });
    return;
  }

  // Validar firma HMAC-SHA256(apiKey_hex_to_bytes, concat(id_llamada, account, cantidad))
  const concat = `${idLlamada}${idCuenta}${cantidad}`;
  const expectedFirma = createHmac('sha256', Buffer.from(API_KEY_HEX, 'hex'))
    .update(concat)
    .digest('hex');
  if (firma !== expectedFirma) {
    reply.code(401).send({
      error: 'firma mismatch',
      expected: expectedFirma.slice(0, 16) + '…',
      got: firma.slice(0, 16) + '…',
    });
    return;
  }

  // Agendar callback simulado tras "pago"
  const status = SIMULATE_FAILURE_STATUS || '200';
  const msg = status === '200' ? 'correcto' : `simulated_failure_${status}`;
  setTimeout(() => {
    void runChallengeResponse(idLlamada, status, msg, debug).catch((err) =>
      app.log.error({ err, idLlamada }, 'challenge-response failed'),
    );
  }, PAYMENT_DELAY_MS);

  // Render HTML simulando el formulario hosted (auto-submit visual feedback)
  reply
    .code(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mock Peanpe</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}.s{width:2rem;height:2rem;margin:0 auto 1rem;border:3px solid #333;border-top-color:#5af074;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body><main>
<div class="s"></div>
<h2>Mock Peanpe v2.0</h2>
<p>Procesando pago simulado…</p>
<pre style="text-align:left;background:#111;padding:1rem;border-radius:6px;font-size:12px">id_llamada: ${idLlamada}
cantidad:   ${cantidad}
status:     ${status}
debug:      ${debug ? 'yes' : 'no'}
callback:   ${WEBHOOK_TARGET}</pre>
<p>Callback en ${PAYMENT_DELAY_MS}ms…</p>
</main></body></html>`);
});

async function runChallengeResponse(
  idLlamada: string,
  status: string,
  msg: string,
  debug: boolean,
): Promise<void> {
  // Step 1: POST con identificador_llamada → esperar securityToken texto plano
  const postBody = new URLSearchParams({ identificador_llamada: idLlamada }).toString();
  const postResp = await fetch(WEBHOOK_TARGET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: postBody,
  });
  if (!postResp.ok) {
    app.log.warn(
      { idLlamada, status: postResp.status },
      'challenge POST rejected — abortando',
    );
    return;
  }
  const token = (await postResp.text()).trim();
  if (!/^\d{10}$/.test(token)) {
    app.log.warn({ idLlamada, token }, 'challenge POST devolvió token con formato inválido');
    return;
  }

  // Step 2: GET con seguridad
  const url = new URL(WEBHOOK_TARGET);
  url.searchParams.set('identificador_llamada', idLlamada);
  url.searchParams.set('seguridad', token);
  url.searchParams.set('status', status);
  url.searchParams.set('msg', msg);
  url.searchParams.set('accion', 'pagar');
  url.searchParams.set('debug', debug ? '1' : '0');
  const getResp = await fetch(url.toString(), { method: 'GET' });
  app.log.info(
    { idLlamada, status: getResp.status, peanpeStatus: status },
    'challenge-response complete',
  );
}

await app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() =>
    app.log.info(
      `mock-peanpe v2.0 listening on :${PORT} → callbacks to ${WEBHOOK_TARGET}`,
    ),
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
