/**
 * E2E smoke tests para los quality fixes de 2026-05-13.
 * Run: node test-e2e-quality-fixes.mjs
 *
 * Asume:
 *  - API en http://localhost:4100
 *  - DB con seed luna-vlc + owner@nightpay.local + ana@local.test (password Test1234!)
 *  - Terminal BARRA-1
 */

const API = 'http://localhost:4100';
const RESULTS = [];

function ok(name, info = '') {
  console.log(`✓ ${name} ${info}`);
  RESULTS.push({ name, status: 'PASS', info });
}
function fail(name, err) {
  console.log(`✗ ${name} — ${err}`);
  RESULTS.push({ name, status: 'FAIL', err });
}

async function login(email, password) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()}`);
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
  // 1. Login owner + operator
  let ownerSession, anaSession;
  try {
    ownerSession = await login('owner@nightpay.local', 'Test1234!');
    ok('login OWNER', `tenant=${ownerSession.user.tenantId.slice(0, 8)}…`);
  } catch (e) {
    fail('login OWNER', e.message);
    return;
  }
  try {
    anaSession = await login('ana@local.test', 'Test1234!');
    ok('login OPERATOR ana');
  } catch (e) {
    fail('login OPERATOR ana', e.message);
    return;
  }

  const ownerToken = ownerSession.accessToken;
  const anaToken = anaSession.accessToken;

  // ─── Test 1: cobro con tip — OPERATOR creator → tip va a ella ──────
  const idk1 = `test-tip-${Date.now()}`;
  let p1;
  try {
    const r = await api(anaToken, 'POST', '/v1/payments', {
      amountCents: 5000,
      terminalExternalId: 'BARRA-1',
      tipCents: 500,
      tipGoesTo: 'operator',
    }, { 'Idempotency-Key': idk1 });
    if (r.status !== 201 && r.status !== 200) {
      fail('cobro con tip OPERATOR', `${r.status} ${JSON.stringify(r.body)}`);
    } else {
      p1 = r.body;
      ok('cobro con tip OPERATOR', `id=${p1.id.slice(0, 8)}… amount=${p1.amountCents}c`);
    }
  } catch (e) {
    fail('cobro con tip OPERATOR', e.message);
  }

  // Verifica en DB: tipCents persistido + platformCommissionBps snapshoteado.
  // Uso stdin pipe para evitar shell quoting issues con las " de Postgres.
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

  if (p1) {
    try {
      const out = await dbQuery(
        `SELECT "tipCents", "tipGoesTo", "platformCommissionBps" FROM payments WHERE id = '${p1.id}';`,
      );
      if (out.includes('500') && out.includes('operator') && out.includes('1000')) {
        ok('tip + platform snapshot persistidos', out.replace(/\s+/g, ' '));
      } else {
        fail('tip + platform snapshot persistidos', `unexpected: ${out}`);
      }
    } catch (e) {
      fail('tip + platform snapshot persistidos', e.message);
    }
  }

  // ─── Test 2: validación cap operator NO aplica a wallet top-up ─────
  // (regresión del fix anterior: wallet top-up bypassa cap)
  try {
    const r = await api(ownerToken, 'POST', '/v1/payments', {
      amountCents: 200000, // 2000€ — supera default cap (1000€) pero owner ignora
      terminalExternalId: 'BARRA-1',
      wallet: { create: true, identifier: 'test-mesa-99' },
    }, { 'Idempotency-Key': `test-wallet-${Date.now()}` });
    if (r.status === 201 || r.status === 200) {
      ok('wallet top-up sin cap', `walletId=${r.body.walletId?.slice(0, 8)}…`);
    } else {
      fail('wallet top-up sin cap', `${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('wallet top-up sin cap', e.message);
  }

  // ─── Test 3: tip a beneficiary explícito (OWNER cobra, tip a Ana) ──
  const anaId = anaSession.user.id;
  const idk3 = `test-tip-benef-${Date.now()}`;
  try {
    const r = await api(ownerToken, 'POST', '/v1/payments', {
      amountCents: 8000,
      terminalExternalId: 'BARRA-1',
      tipCents: 1000,
      tipGoesTo: 'beneficiary',
      tipBeneficiaryUserId: anaId,
    }, { 'Idempotency-Key': idk3 });
    if (r.status === 201 || r.status === 200) {
      ok('cobro OWNER con tip→beneficiary', `id=${r.body.id.slice(0, 8)}…`);
    } else {
      fail('cobro OWNER con tip→beneficiary', `${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('cobro OWNER con tip→beneficiary', e.message);
  }

  // ─── Test 4: tipGoesTo=beneficiary sin tipBeneficiaryUserId → 400 ──
  try {
    const r = await api(anaToken, 'POST', '/v1/payments', {
      amountCents: 1000,
      terminalExternalId: 'BARRA-1',
      tipCents: 100,
      tipGoesTo: 'beneficiary',
    }, { 'Idempotency-Key': `test-tip-bad-${Date.now()}` });
    if (r.status === 400) {
      ok('rechaza tipGoesTo=beneficiary sin user', `400`);
    } else {
      fail('rechaza tipGoesTo=beneficiary sin user', `expected 400 got ${r.status}`);
    }
  } catch (e) {
    fail('rechaza tipGoesTo=beneficiary sin user', e.message);
  }

  // ─── Test 5: balance de Ana refleja tenantId filter ────────────────
  try {
    const r = await api(anaToken, 'GET', '/v1/operators/me/balance');
    if (r.status === 200 && typeof r.body.pendingCents === 'number') {
      ok('GET /me/balance con tenant filter', `pending=${r.body.pendingCents}c lifetime=${r.body.lifetimeGrossCents}c`);
    } else {
      fail('GET /me/balance con tenant filter', `${r.status} ${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /me/balance con tenant filter', e.message);
  }

  // ─── Test 6: GET /me/earnings devuelve tipCents ────────────────────
  try {
    const r = await api(anaToken, 'GET', '/v1/operators/me/earnings');
    if (r.status === 200 && Array.isArray(r.body)) {
      const hasTipField = r.body.length === 0 || 'tipCents' in r.body[0];
      if (hasTipField) {
        ok('GET /me/earnings expone tipCents', `${r.body.length} earnings`);
      } else {
        fail('GET /me/earnings expone tipCents', `tipCents field missing: ${JSON.stringify(r.body[0])}`);
      }
    } else {
      fail('GET /me/earnings expone tipCents', `${r.status}`);
    }
  } catch (e) {
    fail('GET /me/earnings expone tipCents', e.message);
  }

  // ─── Test 7: idempotency — replay del cobro 1 devuelve mismo id ────
  try {
    const r = await api(anaToken, 'POST', '/v1/payments', {
      amountCents: 5000,
      terminalExternalId: 'BARRA-1',
      tipCents: 500,
      tipGoesTo: 'operator',
    }, { 'Idempotency-Key': idk1 });
    if ((r.status === 201 || r.status === 200) && r.body.id === p1?.id) {
      ok('idempotency replay', `same id=${r.body.id.slice(0, 8)}…`);
    } else {
      fail('idempotency replay', `expected ${p1?.id} got ${r.body?.id}`);
    }
  } catch (e) {
    fail('idempotency replay', e.message);
  }

  // ─── Resumen ───────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const failCount = RESULTS.filter((r) => r.status === 'FAIL').length;
  console.log(`RESULTADO: ${pass}/${RESULTS.length} pasados, ${failCount} fallos`);
  if (failCount > 0) {
    console.log('\nFallos:');
    RESULTS.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  ${r.name}: ${r.err}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error general:', e);
  process.exit(1);
});
