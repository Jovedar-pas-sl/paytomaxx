/**
 * E2E test del accumulator pattern para refunds.
 *
 * Escenario: cobro 100€ con BPS 9000 (chica 90%).
 *  - commission = round(10000 * 9000 / 10000) = 9000c (90€)
 *  - 3 refunds fragmentados de 33.33€ (3333c, 3333c, 3334c — total 10000c)
 *  - Con FLOOR antiguo: reversed = floor(3333*9000/10000)*2 + floor(3334*9000/10000)
 *                              = 2999 + 2999 + 3000 = 8998 ≠ 9000 (dust = 2c)
 *  - Con ACCUMULATOR: reversed = 9000 exacto al final (sin dust).
 *
 * Reqs en DB previos: payment AUTHORIZED para poder refundear.
 * Vamos a simular el ciclo entero:
 *   1. Crear payment (OPERATOR Ana, BPS 9000)
 *   2. Forzar AUTHORIZED via SQL (no hay PSP real)
 *   3. Crear earning manualmente vía SQL (transition no se dispara sin PSP)
 *      ... PERO el hook earning está en transition(), así que con SQL directo lo
 *      hacemos a mano.
 *   4. Aplicar 3 refunds via API (cada uno dispara applyRefundToEarning)
 *   5. Verificar earning.reversedCents == commissionCents (9000)
 *   6. Verificar 3 filas en earning_reversals (idempotency)
 */

const API = 'http://localhost:4100';

async function dbQuery(sql) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'nightpay_postgres', 'psql', '-U', 'np', '-d', 'nightpay', '-t']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `psql exit ${code}`));
    });
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
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  const owner = await login('owner@nightpay.local', 'Test1234!');
  const ana = await login('ana@local.test', 'Test1234!');
  console.log(`✓ login OK (owner ${owner.user.id.slice(0,8)}, ana ${ana.user.id.slice(0,8)})`);

  // 0. Asegurar BPS=9000 para Ana
  await dbQuery(`UPDATE users SET "commissionBps" = 9000 WHERE id = '${ana.user.id}';`);
  console.log('✓ Ana commissionBps=9000');

  // 1. Crear payment como Ana
  const idk = `test-refund-${Date.now()}`;
  const r = await api(ana.accessToken, 'POST', '/v1/payments', {
    amountCents: 10000,
    terminalExternalId: 'BARRA-1',
  }, { 'Idempotency-Key': idk });
  if (r.status !== 201 && r.status !== 200) {
    console.error('✗ create payment failed:', r.status, r.body);
    process.exit(1);
  }
  const p = r.body;
  console.log(`✓ payment created id=${p.id.slice(0,8)} amount=10000c`);

  // 2. Simulamos AUTHORIZED via SQL update + insert earning manual
  //    (sin PSP webhook no se dispara la FSM). Esto replica lo que haría
  //    el hook de transition() en producción.
  await dbQuery(`
    UPDATE payments
       SET status = 'AUTHORIZED',
           "providerTxId" = 'mock-tx-${Date.now()}',
           provider = 'WIPAY',
           "availableAmountCents" = 10000
     WHERE id = '${p.id}';
    INSERT INTO operator_earnings ("tenantId", "operatorId", "paymentId", "paymentAmountCents", "commissionBps", "commissionCents", "tipCents")
    VALUES (
      (SELECT "tenantId" FROM payments WHERE id = '${p.id}'),
      '${ana.user.id}',
      '${p.id}',
      10000, 9000, 9000, 0
    ) ON CONFLICT ("paymentId") DO NOTHING;
  `);
  console.log('✓ forzado AUTHORIZED + earning insertado');

  // 3. Tres refunds fragmentados (3333 + 3333 + 3334 = 10000)
  const amounts = [3333, 3333, 3334];
  for (let i = 0; i < amounts.length; i++) {
    const rr = await api(owner.accessToken, 'POST', `/v1/payments/${p.id}/refunds`, {
      paymentId: p.id,
      amountCents: amounts[i],
      reason: `test refund ${i + 1}/3`,
    });
    if (rr.status !== 201 && rr.status !== 200) {
      console.error(`✗ refund ${i+1} failed:`, rr.status, rr.body);
      // Sigue para ver el estado final
    } else {
      console.log(`✓ refund ${i+1}: ${amounts[i]}c → refundId=${rr.body.id?.slice(0,8)}`);
    }
  }

  // 4. Espera breve para que el applyRefundToEarning termine
  await new Promise((r) => setTimeout(r, 500));

  // 5. Verifica reversedCents == 9000 exacto + 3 earning_reversals
  const earningRow = await dbQuery(
    `SELECT "commissionCents", "reversedCents" FROM operator_earnings WHERE "paymentId" = '${p.id}';`,
  );
  console.log(`  earning: ${earningRow.replace(/\s+/g, ' ').trim()}`);

  const reversedRows = await dbQuery(
    `SELECT COUNT(*), SUM("reversedDeltaCents")::int FROM earning_reversals WHERE "earningId" = (SELECT id FROM operator_earnings WHERE "paymentId" = '${p.id}');`,
  );
  console.log(`  earning_reversals: ${reversedRows.replace(/\s+/g, ' ').trim()}`);

  const [comm, rev] = earningRow.split('|').map((s) => parseInt(s.trim(), 10));
  if (comm === 9000 && rev === 9000) {
    console.log('\n✅ ACCUMULATOR OK: reversedCents = commissionCents = 9000 (sin dust)');
  } else {
    console.log(`\n❌ DUST DETECTED: commission=${comm} reversed=${rev} diff=${comm - rev}`);
    process.exit(1);
  }

  // 6. Idempotency: replay del último refund debe ser no-op
  const lastRefundId = await dbQuery(
    `SELECT id FROM refunds WHERE "paymentId" = '${p.id}' ORDER BY "createdAt" DESC LIMIT 1;`,
  );
  const reversalCountBefore = await dbQuery(
    `SELECT COUNT(*)::int FROM earning_reversals WHERE "refundId" = '${lastRefundId.trim()}';`,
  );
  console.log(`  earning_reversals para último refundId: ${reversalCountBefore.trim()} (esperado 1)`);
  if (parseInt(reversalCountBefore.trim(), 10) === 1) {
    console.log('✅ IDEMPOTENCY OK: una fila por refundId');
  } else {
    console.log('❌ IDEMPOTENCY FAIL');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
