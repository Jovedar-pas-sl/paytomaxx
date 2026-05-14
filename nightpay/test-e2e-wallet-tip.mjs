/**
 * E2E test: wallet consume con propina propaga al earning.
 * Flow:
 *   1. Owner crea wallet vacía + top-up 100€
 *   2. Forzamos AUTHORIZED para creditar balance
 *   3. Ana (OPERATOR) consume 20€ + tip 3€
 *   4. Verifica:
 *      - balance baja 23€ (20 + 3)
 *      - earning de Ana: commissionCents = round(2000 * 9000/10000) = 1800c
 *      - earning.tipCents = 300c
 *      - wallet_consumptions.tipCents persistido
 */
const API = 'http://localhost:4100';

async function dbQuery(sql) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'nightpay_postgres', 'psql', '-U', 'np', '-d', 'nightpay', '-t']);
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${code}`)));
    proc.stdin.write(sql + '\n');
    proc.stdin.end();
  });
}

async function login(email, password) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.json();
}

async function api(token, method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

async function main() {
  const owner = await login('owner@nightpay.local', 'Test1234!');
  const ana = await login('ana@local.test', 'Test1234!');
  await dbQuery(`UPDATE users SET "commissionBps" = 9000 WHERE id = '${ana.user.id}';`);
  console.log('✓ login + Ana 9000bps');

  // 1. Crear wallet via top-up 100€
  const r = await api(owner.accessToken, 'POST', '/v1/payments', {
    amountCents: 10000,
    terminalExternalId: 'BARRA-1',
    wallet: { create: true, identifier: 'Mesa 5 — test tip' },
  }, { 'Idempotency-Key': `wallet-tip-${Date.now()}` });
  if (r.status !== 201 && r.status !== 200) {
    console.error('✗ create wallet:', r.status, r.body); process.exit(1);
  }
  const walletId = r.body.walletId;
  const paymentId = r.body.id;
  console.log(`✓ wallet ${walletId.slice(0,8)} + topUp payment ${paymentId.slice(0,8)}`);

  // 2. Forzar AUTHORIZED para activar el balance (sin webhook real)
  await dbQuery(`
    UPDATE payments SET status='AUTHORIZED', "providerTxId"='mock-tx-${Date.now()}', provider='WIPAY'
     WHERE id = '${paymentId}';
    UPDATE client_wallets SET "balanceCents" = 10000 WHERE id = '${walletId}';
  `);
  console.log('✓ wallet balance=10000c (forzado)');

  // 3. Ana consume 20€ + tip 3€ via wallet
  const consumeRes = await api(ana.accessToken, 'POST', `/v1/wallets/${walletId}/consume`, {
    amountCents: 2000,
    category: 'time',
    notes: 'sesión con Ana',
    tipCents: 300,
    tipGoesTo: 'operator',
  }, { 'Idempotency-Key': `consume-tip-${Date.now()}` });
  if (consumeRes.status !== 201 && consumeRes.status !== 200) {
    console.error('✗ consume:', consumeRes.status, consumeRes.body); process.exit(1);
  }
  console.log(`✓ consume OK: balance=${consumeRes.body.newBalanceCents}c (esperado 7700)`);
  console.log(`  earning created: ${consumeRes.body.earningCreated}, commission=${consumeRes.body.earningCommissionCents}c, tip=${consumeRes.body.tipCents}c`);

  // 4. Verifica invariantes
  let allPass = true;
  if (consumeRes.body.newBalanceCents !== 7700) {
    console.log('  ✗ balance esperaba 7700'); allPass = false;
  } else {
    console.log('  ✓ balance correcto (10000 - 2000 - 300 tip)');
  }
  if (consumeRes.body.earningCommissionCents !== 1800) {
    console.log(`  ✗ commission esperaba 1800 (round(2000*9000/10000)), got ${consumeRes.body.earningCommissionCents}`);
    allPass = false;
  } else {
    console.log('  ✓ commission round() = 1800c');
  }
  if (consumeRes.body.tipCents !== 300) {
    console.log(`  ✗ tip esperaba 300, got ${consumeRes.body.tipCents}`); allPass = false;
  } else {
    console.log('  ✓ tip 300c en response');
  }

  // 5. Verifica DB
  const consDb = await dbQuery(`SELECT "amountCents", "tipCents", "tipGoesTo" FROM wallet_consumptions WHERE id = '${consumeRes.body.consumptionId}';`);
  console.log(`  DB wallet_consumptions: ${consDb.replace(/\s+/g, ' ')}`);
  if (consDb.includes('300') && consDb.includes('operator')) {
    console.log('  ✓ wallet_consumptions persistido con tip');
  } else { console.log('  ✗ wallet_consumptions tip missing'); allPass = false; }

  const earnDb = await dbQuery(`SELECT "commissionCents", "tipCents" FROM operator_earnings WHERE "consumptionId" = '${consumeRes.body.consumptionId}';`);
  console.log(`  DB operator_earnings: ${earnDb.replace(/\s+/g, ' ')}`);
  if (earnDb.includes('1800') && earnDb.includes('300')) {
    console.log('  ✓ operator_earnings.tipCents=300 + commissionCents=1800');
  } else { console.log('  ✗ operator_earnings tip/commission mismatch'); allPass = false; }

  if (allPass) console.log('\n✅ WALLET CONSUME + TIP OK');
  else { console.log('\n❌ FAILED'); process.exit(1); }
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
