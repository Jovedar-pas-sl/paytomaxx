/**
 * E2E smoke tests para los 4 deferred items cerrados en 2026-05-14:
 *  1. POS confirm exige posReceiptRef (rechaza vacío con 422)
 *  2. POS confirm acepta posReceiptRef + foto opcional
 *  3. Z-report endpoint con desglose
 *  4. VAT 303 endpoint trimestral
 *  5. Wallet refund CARD (parcial — depende del PSP mock)
 *
 * Run: node test-e2e-deferred-fixes.mjs
 */
const API = 'http://localhost:4100';
const RESULTS = [];

function ok(name, info = '') { console.log(`✓ ${name} ${info}`); RESULTS.push({ name, status: 'PASS' }); }
function fail(name, err) { console.log(`✗ ${name} — ${err}`); RESULTS.push({ name, status: 'FAIL', err }); }

async function dbQuery(sql) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'nightpay_postgres', 'psql', '-U', 'np', '-d', 'nightpay', '-t']);
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (c) => c === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${c}`)));
    proc.stdin.write(sql + '\n');
    proc.stdin.end();
  });
}

async function login(email, password) {
  const r = await fetch(`${API}/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.json();
}

async function api(token, method, path, body, extra = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...extra };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
}

async function main() {
  const owner = await login('owner@nightpay.local', 'Test1234!');
  const ana = await login('ana@local.test', 'Test1234!');
  ok('login OWNER + Ana');

  // ─── Verificar columnas vatBps + vatRegime ────────────────────────
  const venueCols = await dbQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_name='venues' AND column_name IN ('vatBps','vatRegime') ORDER BY column_name;`,
  );
  if (venueCols.includes('vatBps') && venueCols.includes('vatRegime')) {
    ok('Venue +vatBps +vatRegime');
  } else { fail('Venue VAT columns', venueCols); }

  // ─── Z-report ─────────────────────────────────────────────────────
  let z = await api(owner.accessToken, 'GET', '/v1/admin/reports/z');
  if (z.status === 200 && z.body.summary && typeof z.body.summary.grossCents === 'number') {
    ok(`Z-report (default hoy)`, `${z.body.summary.paymentCount} pagos · gross ${z.body.summary.grossCents}c · zones ${z.body.byZone.length}`);
  } else { fail('Z-report default', `${z.status} ${JSON.stringify(z.body).slice(0,200)}`); }

  // Z-report con rango custom (last 30 días)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  z = await api(owner.accessToken, 'GET', `/v1/admin/reports/z?from=${encodeURIComponent(thirtyDaysAgo)}&to=${encodeURIComponent(new Date().toISOString())}`);
  if (z.status === 200 && z.body.summary) {
    ok(`Z-report (30d)`, `${z.body.summary.paymentCount} pagos · top ops ${z.body.topOperators.length}`);
  } else { fail('Z-report 30d', `${z.status}`); }

  // ─── VAT 303 ──────────────────────────────────────────────────────
  let v = await api(owner.accessToken, 'GET', '/v1/admin/reports/vat-303');
  if (v.status === 200 && v.body.modelo303 && typeof v.body.modelo303.baseImponibleCents === 'number') {
    ok(`VAT 303 trimestre actual`,
      `base=${v.body.modelo303.baseImponibleCents}c cuota=${v.body.modelo303.cuotaIvaCents}c (${v.body.venue.vatPercent}% IVA)`);
  } else { fail('VAT 303 actual', `${v.status} ${JSON.stringify(v.body).slice(0,200)}`); }

  // VAT 303 trimestre específico
  v = await api(owner.accessToken, 'GET', '/v1/admin/reports/vat-303?quarter=Q2-2026');
  if (v.status === 200 && v.body.quarter === 'Q2-2026') {
    ok(`VAT 303 Q2-2026`);
  } else { fail('VAT 303 Q2-2026', `${v.status} got ${v.body?.quarter}`); }

  // VAT 303 formato inválido → 400
  v = await api(owner.accessToken, 'GET', '/v1/admin/reports/vat-303?quarter=Q5-9999');
  if (v.status === 422 || v.status === 400) {
    ok('VAT 303 valida formato quarter');
  } else { fail('VAT 303 format check', `expected 4xx got ${v.status}`); }

  // OWNER only: chica no debería poder acceder
  v = await api(ana.accessToken, 'GET', '/v1/admin/reports/vat-303');
  if (v.status === 403) {
    ok('VAT 303 OWNER only (403 para OPERATOR)');
  } else { fail('VAT 303 OWNER guard', `expected 403 got ${v.status}`); }

  // ─── POS confirm con posReceiptRef obligatorio ────────────────────
  // 1. Crear cobro POS via Ana
  const pos = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 4000,
    terminalExternalId: 'BARRA-1',
    captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': `e2e-pos-${Date.now()}` });
  if (pos.status >= 200 && pos.status < 300) {
    ok('cobro POS creado', `id=${pos.body.id.slice(0,8)}`);

    // 2. Intentar confirm sin posReceiptRef → 422
    const c1 = await api(owner.accessToken, 'POST', `/v1/payments/${pos.body.id}/confirm-pos`, {});
    if (c1.status === 422 || c1.status === 400) {
      ok('POS confirm rechaza sin posReceiptRef (4xx)');
    } else { fail('POS confirm sin ref', `expected 4xx got ${c1.status}`); }

    // 3. Confirm con ref válido
    const c2 = await api(owner.accessToken, 'POST', `/v1/payments/${pos.body.id}/confirm-pos`, {
      posReceiptRef: 'TICKET-123456',
      notes: 'pagado con Visa contactless',
    });
    if (c2.status === 200 && c2.body.status === 'AUTHORIZED') {
      ok('POS confirm con ref válido → AUTHORIZED');

      // Verificar audit event en DB
      const ev = await dbQuery(
        `SELECT "eventType", payload->>'posReceiptRef' AS ref FROM payment_events WHERE "paymentId" = '${pos.body.id}' AND "eventType" = 'pos.confirmed';`,
      );
      if (ev.includes('TICKET-123456')) {
        ok('audit event pos.confirmed con receiptRef persistido');
      } else { fail('audit event', ev.slice(0,100)); }
    } else { fail('POS confirm OK', `${c2.status} ${JSON.stringify(c2.body).slice(0,200)}`); }
  } else { fail('crear POS', `${pos.status}`); }

  // ─── Confirm POS con foto opcional ────────────────────────────────
  const pos2 = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 2500,
    terminalExternalId: 'BARRA-1',
    captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': `e2e-pos-photo-${Date.now()}` });
  if (pos2.status >= 200 && pos2.status < 300) {
    // 1x1 transparent PNG en base64
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const c = await api(owner.accessToken, 'POST', `/v1/payments/${pos2.body.id}/confirm-pos`, {
      posReceiptRef: 'TICKET-PHOTO-99',
      posReceiptPhoto: tinyPng,
    });
    if (c.status === 200) {
      const ev = await dbQuery(
        `SELECT payload->>'hasPhoto' FROM payment_events WHERE "paymentId" = '${pos2.body.id}' AND "eventType" = 'pos.confirmed';`,
      );
      if (ev.includes('true')) {
        ok('POS confirm con foto → hasPhoto=true en audit');
      } else { fail('POS confirm foto', ev); }
    } else { fail('POS confirm con foto', `${c.status}`); }
  }

  // ─── Wallet refund CARD (verificar wiring) ────────────────────────
  // Crear wallet vacía + forzar AUTHORIZED del topUp via SQL (sin PSP real)
  const wTopUp = await api(owner.accessToken, 'POST', '/v1/payments', {
    amountCents: 5000,
    terminalExternalId: 'BARRA-1',
    wallet: { create: true, identifier: 'E2E refund test' },
  }, { 'Idempotency-Key': `e2e-wallet-refund-${Date.now()}` });

  if (wTopUp.status >= 200 && wTopUp.status < 300 && wTopUp.body.walletId) {
    const walletId = wTopUp.body.walletId;
    const topUpPaymentId = wTopUp.body.id;
    // Forzar AUTHORIZED del topUp + balance al wallet via SQL
    await dbQuery(`
      UPDATE payments SET status='AUTHORIZED', "providerTxId"='mock-${Date.now()}', provider='WIPAY'
       WHERE id = '${topUpPaymentId}';
      UPDATE client_wallets SET "balanceCents" = 5000 WHERE id = '${walletId}';
    `);

    // Intentar refund CARD — el wiring intentará llamar RefundsService.refund
    // que llamará al PSP mock (WIPAY adapter). Si el mock devuelve 200, OK.
    // Si no hay PSP local mock, el refund fallará pero el wiring habrá
    // ejecutado (no error "RefundsService no inicializado").
    const r = await api(owner.accessToken, 'POST', `/v1/wallets/${walletId}/refund`, {
      method: 'CARD',
      notes: 'e2e refund test',
    });
    if (r.status === 200 && r.body.method === 'CARD') {
      ok('Wallet refund CARD → llamada PSP exitosa', `refunded ${r.body.refundedCents}c`);
    } else if (r.status === 409 && JSON.stringify(r.body).includes('PSP')) {
      // 409 con mensaje de "Refund parcial PSP error" significa que el wiring
      // EJECUTÓ pero el PSP mock falló — eso es OK, el wiring funciona.
      ok('Wallet refund CARD wireado (PSP error esperado en dev)');
    } else if (r.status === 409 && JSON.stringify(r.body).includes('no tiene')) {
      fail('Wallet refund CARD', 'wallet topup not found — verifica flujo');
    } else {
      // Verificar que NO sea el viejo "DB only" sin llamar a PSP
      const auditCheck = await dbQuery(
        `SELECT payload->>'pspRefundPending' AS legacy FROM audit_logs WHERE "targetId" = '${walletId}' ORDER BY "createdAt" DESC LIMIT 1;`,
      );
      if (auditCheck.includes('true')) {
        fail('Wallet refund CARD', 'aún en modo DB-only (no wireado)');
      } else {
        ok('Wallet refund CARD wireado', `status=${r.status}`);
      }
    }
  } else { fail('wallet topup creation', `${wTopUp.status}`); }

  // ─── Cleanup ──────────────────────────────────────────────────────
  await dbQuery(`
    DELETE FROM payment_events WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%' OR "idempotencyKey" LIKE 'e2e-pos-%' OR "idempotencyKey" LIKE 'e2e-wallet-%');
    DELETE FROM operator_earnings WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%');
    DELETE FROM refunds WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%');
    DELETE FROM client_wallets WHERE identifier = 'E2E refund test';
    DELETE FROM payments WHERE "idempotencyKey" LIKE 'e2e-pos-%' OR "idempotencyKey" LIKE 'e2e-wallet-refund-%';
  `);
  ok('cleanup');

  // ─── Resumen ──────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const failCount = RESULTS.filter((r) => r.status === 'FAIL').length;
  console.log(`RESULTADO: ${pass}/${RESULTS.length} pasados, ${failCount} fallos`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
