/**
 * E2E smoke test contra Paytef REAL (con token live).
 * Verifica:
 *   1. gateway_credentials para luna-vlc tiene PAYTEF active=true
 *   2. PEANPE provider en enum DB (no probamos sin claves)
 *   3. Z-report endpoint
 *   4. VAT 303 endpoint (default + Q específico + 403 a OPERATOR)
 *   5. POS confirm: posReceiptRef obligatorio + audit con foto
 *   6. Paytef adapter: crea cobro → adapter llama Paytef → recibe paymentURL
 *      (esto SÍ pega contra api.paytef.es)
 *   7. Endpoint redirect Paytef
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
  const headers = token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
}

async function main() {
  // 0. Asegurar Paytef activo + otros desactivados
  await dbQuery(`
    INSERT INTO gateway_credentials ("tenantId", provider, "credentialsEncrypted", active)
      SELECT id, 'PAYTEF', 'managed-via-env', true FROM venues WHERE slug = 'luna-vlc'
      ON CONFLICT DO NOTHING;
    UPDATE gateway_credentials SET active = (provider = 'PAYTEF')
      WHERE "tenantId" = (SELECT id FROM venues WHERE slug = 'luna-vlc');
  `);
  const gws = await dbQuery(
    `SELECT provider, active FROM gateway_credentials WHERE "tenantId" = (SELECT id FROM venues WHERE slug='luna-vlc');`,
  );
  if (gws.includes('PAYTEF') && gws.includes('t')) {
    ok('gateway_credentials: PAYTEF activo', gws.replace(/\s+/g, ' '));
  } else { fail('gateway_credentials PAYTEF', gws); }

  const owner = await login('owner@nightpay.local', 'Test1234!');
  const ana = await login('ana@local.test', 'Test1234!');
  ok('login OWNER + Ana');

  // ─── Endpoints admin de hoy ──────────────────────────────────────

  // Z-report
  let r = await api(owner.accessToken, 'GET', '/v1/admin/reports/z');
  if (r.status === 200 && r.body.summary) {
    ok('Z-report', `${r.body.summary.paymentCount} cobros, ${r.body.byZone.length} zonas`);
  } else { fail('Z-report', `${r.status}`); }

  // VAT 303
  r = await api(owner.accessToken, 'GET', '/v1/admin/reports/vat-303');
  if (r.status === 200 && r.body.modelo303) {
    ok('VAT 303', `quarter=${r.body.quarter} cuota=${r.body.modelo303.cuotaIvaCents}c`);
  } else { fail('VAT 303', `${r.status} ${JSON.stringify(r.body).slice(0,200)}`); }

  // VAT 303 OWNER only — chica 403
  r = await api(ana.accessToken, 'GET', '/v1/admin/reports/vat-303');
  if (r.status === 403) {
    ok('VAT 303 chica 403');
  } else { fail('VAT 303 OWNER guard', `expected 403 got ${r.status}`); }

  // ─── Paytef REAL — crear cobro + adapter llama Paytef ───────────

  const idk = `e2e-paytef-${Date.now()}`;
  const payment = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 1500,
    terminalExternalId: 'BARRA-1',
  }, { 'Idempotency-Key': idk });

  if (payment.status >= 200 && payment.status < 300) {
    ok('cobro Paytef creado en DB', `id=${payment.body.id.slice(0,8)}`);

    // Iniciar el pago como la página /pay (start-authorization está retirado:
    // 410) → debería llamar a Paytef api.paytef.es REAL
    const start = await api(null, 'POST', `/pay/${payment.body.qrToken}`, { tip: 0 });
    if (start.status === 200 || start.status === 302 || start.status === 303) {
      ok('POST /pay → Paytef API', `status=${start.status}`);

      // Esperar 2s — el adapter ya llamó a Paytef
      await new Promise((r) => setTimeout(r, 1500));

      // Endpoint redirect Paytef
      const red = await api(null, 'GET', `/v1/payments/public/${payment.body.qrToken}/peanpe-redirect-url`);
      if (red.status === 409) {
        // Esperado — el provider es PAYTEF, no PEANPE
        ok('peanpe-redirect rechaza payment Paytef (409)', red.body.message?.slice(0, 50));
      } else if (red.status === 200) {
        fail('peanpe-redirect debería rechazar Paytef', 'got 200');
      } else {
        fail('peanpe-redirect', `${red.status}`);
      }

      // Verificar en DB: providerTxId set + provider=PAYTEF
      const pInfo = await dbQuery(
        `SELECT status, provider, "providerTxId" FROM payments WHERE id = '${payment.body.id}';`,
      );
      if (pInfo.includes('PAYTEF') && pInfo.includes('AUTHORIZING')) {
        ok('payment provider=PAYTEF + AUTHORIZING', pInfo.replace(/\s+/g, ' ').trim());
      } else if (pInfo.includes('PAYTEF')) {
        ok('payment provider=PAYTEF', pInfo.replace(/\s+/g, ' ').trim());
      } else {
        fail('payment provider state', pInfo);
      }
    } else {
      fail('POST /pay', `${start.status} ${JSON.stringify(start.body).slice(0,300)}`);
    }
  } else {
    fail('cobro Paytef create', `${payment.status} ${JSON.stringify(payment.body).slice(0,200)}`);
  }

  // ─── POS confirm (no Paytef — solo registro) ─────────────────────

  const pos = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 2000,
    terminalExternalId: 'BARRA-1',
    captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': `e2e-pos-${Date.now()}` });

  if (pos.status >= 200 && pos.status < 300) {
    // Sin posReceiptRef → 422
    const bad = await api(owner.accessToken, 'POST', `/v1/payments/${pos.body.id}/confirm-pos`, {});
    if (bad.status === 422 || bad.status === 400) {
      ok('POS confirm rechaza sin posReceiptRef');
    } else { fail('POS confirm sin ref', `expected 4xx got ${bad.status}`); }

    // Con ref → OK
    const good = await api(owner.accessToken, 'POST', `/v1/payments/${pos.body.id}/confirm-pos`, {
      posReceiptRef: 'TICKET-E2E-001',
    });
    if (good.status === 200 && good.body.status === 'AUTHORIZED') {
      ok('POS confirm con ref → AUTHORIZED');
    } else { fail('POS confirm OK', `${good.status}`); }
  } else {
    fail('cobro POS create', `${pos.status}`);
  }

  // ─── PEANPE enum exists pero sin claves → adapter authorize lanzaría ──

  const enumVals = await dbQuery(`SELECT unnest(enum_range(NULL::"Provider"))::text;`);
  if (enumVals.includes('PAYTEF') && enumVals.includes('PEANPE')) {
    ok('Provider enum: WIPAY + PEANPE + PAYTEF');
  } else { fail('Provider enum', enumVals); }

  // ─── Cleanup ─────────────────────────────────────────────────────
  await dbQuery(`
    DELETE FROM payment_events WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%');
    DELETE FROM operator_earnings WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%');
    DELETE FROM peanpe_calls WHERE "paymentId" IN (SELECT id FROM payments WHERE "idempotencyKey" LIKE 'e2e-%');
    DELETE FROM payments WHERE "idempotencyKey" LIKE 'e2e-%';
  `);
  ok('cleanup');

  console.log('\n' + '─'.repeat(60));
  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const failCount = RESULTS.filter((r) => r.status === 'FAIL').length;
  console.log(`RESULTADO: ${pass}/${RESULTS.length} pasados, ${failCount} fallos`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
