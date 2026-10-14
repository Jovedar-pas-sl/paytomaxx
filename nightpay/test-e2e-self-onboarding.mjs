/**
 * E2E test del fix self-onboarding token single-use.
 * Antes: token quedaba activo 72h reutilizable.
 * Ahora: invalidado tras primer submit.
 *
 * Como falta env OPERATOR_BASE_URL para usar el endpoint admin que genera el
 * link, generamos el JWT + hash directamente y replicamos el setup en DB.
 */
import { createHmac, createHash } from 'node:crypto';
const API = 'http://localhost:4100';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('Pon JWT_SECRET en el entorno (el de .env.local)');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(payload, secret, expSec = 3600 * 72) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expSec };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(fullPayload));
  const sig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

async function dbQuery(sql) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'nightpay_postgres', 'psql', '-U', 'np', '-d', 'nightpay', '-t']);
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${code}`)));
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

async function api(token, method, path, body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  const ana = await login('ana@local.test', 'Test1234!');
  console.log(`✓ login OK (ana=${ana.user.id.slice(0, 8)})`);

  // 1. Generamos el token directamente (mismo formato que produce el service)
  const token = signJwt(
    { sub: ana.user.id, tenantId: ana.user.tenantId, purpose: 'operator-self-onboarding' },
    JWT_SECRET,
  );
  const tokenHash = sha256Hex(token);
  await dbQuery(
    `UPDATE users SET "selfOnboardingToken" = '${tokenHash}' WHERE id = '${ana.user.id}';`,
  );
  console.log(`✓ token + hash en DB`);

  // 2. GET perfil (sin auth, solo token en path) — debería funcionar
  const profile = await api(null, 'GET', `/v1/operators/self-onboarding/${token}`);
  if (profile.status === 200) {
    console.log(`✓ GET profile OK (email=${profile.body.email})`);
  } else {
    console.error('✗ GET profile:', profile.status, profile.body);
    process.exit(1);
  }

  // 3. Primer submit — debería ser 200
  const submit1 = await api(null, 'POST', `/v1/operators/self-onboarding/${token}`, {
    phone: '+34600000000',
  });
  if (submit1.status === 200) {
    console.log(`✓ submit #1 OK (200)`);
  } else {
    console.error('✗ submit #1:', submit1.status, submit1.body);
    process.exit(1);
  }

  // 4. Segundo submit con mismo token — debería ser 401 (token invalidado)
  const submit2 = await api(null, 'POST', `/v1/operators/self-onboarding/${token}`, {
    phone: '+34611111111',
  });
  if (submit2.status === 401) {
    console.log(`✓ submit #2 RECHAZADO (401) — token single-use confirmado`);
    console.log(`  body: ${JSON.stringify(submit2.body).slice(0, 100)}`);
  } else {
    console.error(`✗ submit #2 ESPERABA 401 GOT ${submit2.status}:`, submit2.body);
    process.exit(1);
  }

  // 5. GET profile con el token usado también debería fallar
  const profile2 = await api(null, 'GET', `/v1/operators/self-onboarding/${token}`);
  if (profile2.status === 401) {
    console.log(`✓ GET profile post-submit RECHAZADO (401)`);
  } else {
    console.error(`✗ GET profile post-submit ESPERABA 401 GOT ${profile2.status}`);
    process.exit(1);
  }

  console.log('\n✅ SELF-ONBOARDING SINGLE-USE OK');
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
