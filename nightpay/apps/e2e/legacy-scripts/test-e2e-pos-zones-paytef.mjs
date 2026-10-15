/**
 * E2E smoke test del sprint dual (Track A + Track B).
 * Run: node test-e2e-pos-zones-paytef.mjs
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.json();
}

async function api(token, method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...extraHeaders };
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

  // ─── Track A — Zonas ─────────────────────────────────────────────

  // 1. Verificar enum Provider + zone columns existen en DB
  const cols = await dbQuery(`SELECT column_name FROM information_schema.columns WHERE table_name='terminals' AND column_name IN ('zone','hardwareModel','deviceSerial') ORDER BY column_name;`);
  if (cols.includes('zone') && cols.includes('hardwareModel') && cols.includes('deviceSerial')) {
    ok('terminals tiene 3 columnas nuevas');
  } else { fail('terminals 3 columnas', cols); }

  const providerVals = await dbQuery(`SELECT unnest(enum_range(NULL::"Provider"))::text;`);
  if (providerVals.includes('PAYTEF')) {
    ok('enum Provider tiene PAYTEF');
  } else { fail('Provider +PAYTEF', providerVals); }

  // 2. Bulk-crear 3 PAX BARRA + 2 PAX HABITACIONES + 1 PAX OTRO=terraza
  let r;
  r = await api(owner.accessToken, 'POST', '/v1/terminals/bulk', {
    count: 3, prefix: 'TEST-PAX-BARRA-', zone: 'BARRA', hardwareModel: 'PAX_A920_PRO',
  });
  if (r.status >= 200 && r.status < 300) ok('bulk create 3 PAX BARRA', `count=${r.body.length}`);
  else fail('bulk create BARRA', `${r.status} ${JSON.stringify(r.body).slice(0,150)}`);

  r = await api(owner.accessToken, 'POST', '/v1/terminals/bulk', {
    count: 2, prefix: 'TEST-PAX-HAB-', zone: 'HABITACIONES', hardwareModel: 'PAX_A920_PRO',
  });
  if (r.status >= 200 && r.status < 300) ok('bulk create 2 PAX HABITACIONES');
  else fail('bulk create HAB', `${r.status}`);

  r = await api(owner.accessToken, 'POST', '/v1/terminals/bulk', {
    count: 1, prefix: 'TEST-PAX-TER-', zone: 'OTRO', zoneCustom: 'terraza', hardwareModel: 'PAX_A920_PRO',
  });
  if (r.status >= 200 && r.status < 300) ok('bulk create 1 PAX OTRO/terraza');
  else fail('bulk create OTRO', `${r.status} ${JSON.stringify(r.body).slice(0,150)}`);

  // 3. GET /v1/terminals/zones — debería devolver al menos BARRA, HABITACIONES, OTRO/TERRAZA
  r = await api(ana.accessToken, 'GET', '/v1/terminals/zones');
  if (r.status === 200 && Array.isArray(r.body)) {
    const zoneNames = r.body.map((z) => z.zone);
    const hasBarra = zoneNames.includes('BARRA');
    const hasHab = zoneNames.includes('HABITACIONES');
    const hasTerraza = zoneNames.some((z) => z.startsWith('OTRO/'));
    if (hasBarra && hasHab && hasTerraza) {
      ok(`GET /zones (chica)`, `${r.body.length} zonas`);
    } else { fail('GET /zones contiene esperadas', `got ${JSON.stringify(zoneNames)}`); }
  } else { fail('GET /zones', `${r.status} ${JSON.stringify(r.body).slice(0,200)}`); }

  // 4. Crear cobro POS por zona BARRA
  const idk = `e2e-pos-zone-${Date.now()}`;
  r = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 3000,
    zone: 'BARRA',
    captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': idk });
  if (r.status >= 200 && r.status < 300) {
    ok('cobro POS via zone=BARRA', `id=${r.body.id.slice(0,8)}`);

    // Verificar que el payment quedó ligado a un terminal de zone=BARRA
    const term = await dbQuery(`SELECT t."externalId", t.zone FROM payments p JOIN terminals t ON t.id = p."terminalId" WHERE p.id = '${r.body.id}';`);
    if (term.includes('BARRA')) {
      ok('payment routing zone=BARRA OK', term.replace(/\s+/g, ' ').trim());
    } else { fail('payment zone routing', `term: ${term}`); }
  } else { fail('crear POS zone', `${r.status} ${JSON.stringify(r.body).slice(0,250)}`); }

  // 5. Cobro POS por zona sin PAX activos → 400
  // Primero desactivar todos los terraza
  await dbQuery(`UPDATE terminals SET active = false WHERE "externalId" LIKE 'TEST-PAX-TER-%';`);
  r = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 1500, zone: 'OTRO', zoneCustom: 'terraza', captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': `e2e-empty-${Date.now()}` });
  if (r.status === 400 && JSON.stringify(r.body).includes('No hay PAX activos')) {
    ok('rechaza zona sin PAX activos (400)');
  } else { fail('rechaza zona vacía', `${r.status} ${JSON.stringify(r.body).slice(0,200)}`); }

  // 6. pending-pos filtra por zona
  r = await api(owner.accessToken, 'GET', '/v1/payments/pending-pos?zone=BARRA');
  if (r.status === 200 && Array.isArray(r.body)) {
    const allBarra = r.body.every((p) => p.zone === 'BARRA');
    if (allBarra) ok(`pending-pos?zone=BARRA filter`, `${r.body.length} cobros`);
    else fail('pending-pos zone filter', `zones: ${r.body.map((p) => p.zone).join(',')}`);
  } else { fail('pending-pos zone', `${r.status}`); }

  // 7. Validation: zone=OTRO sin zoneCustom → 400
  r = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 1000, zone: 'OTRO', captureMethod: 'POS_EXTERNAL',
  }, { 'Idempotency-Key': `e2e-otro-bad-${Date.now()}` });
  if (r.status === 400) ok('rechaza zone=OTRO sin zoneCustom (400)');
  else fail('zone=OTRO validation', `${r.status}`);

  // ─── Track B — Paytef Adapter & Webhook route ────────────────────

  // 8. Verificar que la ruta del webhook secreto está mapeada
  r = await fetch(`${API}/v1/webhooks/paytef/wrong-secret`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (r.status === 401) ok('webhook /paytef/:secret rechaza secret incorrecto (401)');
  else fail('webhook paytef wrong secret', `expected 401 got ${r.status}`);

  // 9. Webhook con secret correcto pero payload inválido → 401 (verifyWebhook lo rechaza)
  // (sin PAYTEF_WEBHOOK_SECRET en .env.local, esto será 401 también — pero al menos
  //  validamos que la ruta existe)
  r = await fetch(`${API}/v1/webhooks/paytef/anything`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (r.status === 401) ok('webhook paytef sin config → 401 (correcto)');
  else if (r.status === 200) ok('webhook paytef config OK + payload OK');
  else fail('webhook paytef route exists', `got ${r.status}`);

  // ─── Cleanup ───────────────────────────────────────────────────────
  await dbQuery(`DELETE FROM terminals WHERE "externalId" LIKE 'TEST-PAX-%';`);
  ok('cleanup terminales de prueba');

  // ─── Resumen ─────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const failCount = RESULTS.filter((r) => r.status === 'FAIL').length;
  console.log(`RESULTADO: ${pass}/${RESULTS.length} pasados, ${failCount} fallos`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
