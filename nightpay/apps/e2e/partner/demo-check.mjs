#!/usr/bin/env node
// Comprueba la demo desplegada contra lo que dicen las guías (PR 8 B, B3).
// Node 22, módulo ES, sin dependencias. Solo con una clave de prueba:
//
//   OXP_KEY=oxp_test_… OXP_BASE=https://<demo-api>/v1/partner node apps/e2e/partner/demo-check.mjs
//
// Lo lanza .github/workflows/partner-demo.yml (a mano, nunca contra
// producción). Nunca a la vez que carga.mjs. Sale con 1 al primer fallo.
// Escribe el paso, el estado HTTP y el Request-Id; nunca la clave, un código
// OXC1: ni un saldo.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allOperations, businessDate, guardEnv, luhn, makeClient, makeLog, random4 } from './comun.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDES = join(HERE, '../../../docs/partner-api/guides/es');

/**
 * El id de la corrida: DEMOCHK-<AAAAMMDDhhmmss UTC>-<4 al azar>. Si las 14
 * cifras pasaran Luhn (la API tomaría `reference` por una tarjeta: 422), se
 * usa el segundo siguiente.
 */
export function runId(now = new Date()) {
  const t = new Date(now.getTime());
  let stamp = t.toISOString().replace(/\D/g, '').slice(0, 14);
  while (luhn(stamp)) {
    t.setUTCSeconds(t.getUTCSeconds() + 1);
    stamp = t.toISOString().replace(/\D/g, '').slice(0, 14);
  }
  return `DEMOCHK-${stamp}-${random4()}`;
}

/** Los bloques de código de un lenguaje, en orden. */
export function extractBlocks(markdown, lang) {
  const text = markdown.replace(/\r\n/g, '\n');
  return [...text.matchAll(/^```([a-z]*)\n([\s\S]*?)^```$/gm)].filter((m) => m[1] === lang).map((m) => m[2]);
}

/** Los bloques ```js con su nombre, sacado de su primera línea `// <nombre>.mjs`. */
export function extractJsBlocks(markdown) {
  const out = new Map();
  for (const code of extractBlocks(markdown, 'js')) {
    const name = /^\/\/ ([a-z0-9-]+\.mjs)\b/.exec(code)?.[1];
    if (name) out.set(name, code);
  }
  return out;
}

const log = makeLog('demo-check');

/** El `code` de un error (snake_case); nunca otro texto de la respuesta (un código OXC1: también va en `code`). */
const errCode = (r) => (typeof r?.data?.code === 'string' && /^[a-z_]+$/.test(r.data.code) ? ` ${r.data.code}` : '');

function fail(step, r, expected) {
  log(`FALLO · ${step} → ${r ? r.status : '-'}${errCode(r)}${expected ? ` (esperado ${expected})` : ''} · Request-Id ${r?.requestId ?? '-'}`);
  process.exit(1);
}

function ok(step, r) {
  log(`ok · ${step} → ${r.status}${errCode(r)} · Request-Id ${r.requestId}`);
}

/** ¿Responde lo que dice la tabla? `want` = { status, code?, reason? }. */
function check(step, r, want) {
  const good = r.status === want.status && (want.code === undefined || r.data?.code === want.code) && (want.reason === undefined || r.data?.reason === want.reason);
  const label = [want.status, want.code, want.reason && `reason ${want.reason}`].filter(Boolean).join(' ');
  if (!good) fail(step, r, label);
  ok(step, r);
}

/** Corre un guion sacado de las guías. Su salida se queda aquí: puede llevar un saldo o un código. */
function runSnippet(cmd, args, cwd, env) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, OXP_BASE: env.base, OXP_KEY: env.key }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const env = guardEnv(process.env, log);
  const call = makeClient(env);
  const fx = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
  const link = (name) => fx.link + fx.fixtures[name].token;
  const id = runId();
  const started = new Date();
  log(`corrida ${id}`);

  // 1. Solo la demo: livemode false; después, el reinicio.
  const me = await call('GET', '/me');
  if (me.status !== 200 || me.data?.livemode !== false) fail('1 GET /me con livemode false', me, '200 livemode:false');
  ok('1 GET /me (livemode false)', me);
  const reset = async (step) => {
    const r = await call('POST', '/test/fixtures/reset');
    check(step, r, { status: 204 });
  };
  await reset('1 reinicio de las fichas');

  // 2. El código de las guías, tal cual.
  const dir = mkdtempSync(join(tmpdir(), 'demo-check-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const es01 = readFileSync(join(GUIDES, '01-empieza.md'), 'utf8');
  const es04 = readFileSync(join(GUIDES, '04-cargar-saldo.md'), 'utf8');
  const es07 = readFileSync(join(GUIDES, '07-pruebas-en-la-demo.md'), 'utf8');
  for (const [name, code] of [...extractJsBlocks(es01), ...extractJsBlocks(es04)]) writeFileSync(join(dir, name), code);

  const tres = await runSnippet(process.execPath, ['tres-llamadas.mjs'], dir, env);
  if (tres.code !== 0) fail('2 tres-llamadas.mjs sale con 0', { status: `salida ${tres.code}` });
  log('ok · 2 tres-llamadas.mjs → salida 0');

  const curl01 = extractBlocks(es01, 'bash')[0].split('\n').filter((l) => !l.startsWith('export OXP_')).join('\n');
  writeFileSync(join(dir, 'curl-01.sh'), curl01);
  const c1 = await runSnippet('bash', ['curl-01.sh'], dir, env);
  const objects = (c1.out.match(/"object"\s*:/g) ?? []).length;
  if (c1.code !== 0 || objects !== 3 || /"code"\s*:/.test(c1.out)) {
    fail('2 curl del capítulo 1', { status: `salida ${c1.code}, ${objects} "object"` }, 'tres "object" y ningún "code"');
  }
  log('ok · 2 curl del capítulo 1 → tres "object", ningún "code"');

  writeFileSync(join(dir, 'curl-07.sh'), extractBlocks(es07, 'bash')[0]);
  const c7 = await runSnippet('bash', ['curl-07.sh'], dir, env);
  if (c7.code !== 0 || !/"object"\s*:\s*"test_live_code"/.test(c7.out)) fail('2 curl del capítulo 7', { status: `salida ${c7.code}` }, 'test_live_code');
  log('ok · 2 curl del capítulo 7 → test_live_code');

  // 3. Las 9 fichas, por enlace y por código, y los 7 textos de muestra.
  const storedUid = fx.fixtures.ficha_uid.uid;
  for (const [name, f] of Object.entries(fx.fixtures)) {
    const r = await call('POST', '/wallet/balance', { body: { qr: link(name), nfc_uid: f.uid ?? storedUid } });
    check(`3 ${name} por enlace`, r, f.by_link);
    if (f.other_uid) {
      const o = await call('POST', '/wallet/balance', { body: { qr: link(name), nfc_uid: fx.other_uid } });
      check(`3 ${name} por enlace con otro UID`, o, f.other_uid);
    }
    const lc = await call('POST', '/test/live-codes', { body: { fixture: name } });
    if (lc.status !== 201 || lc.data?.object !== 'test_live_code' || lc.data?.livemode !== false) fail(`3 ${name} código de prueba`, lc, '201 test_live_code');
    const byCode = await call('POST', '/wallet/balance', { body: { qr: lc.data.code } });
    check(`3 ${name} por código`, byCode, f.by_code);
  }
  for (const [i, s] of fx.samples.entries()) {
    const r = await call('POST', '/wallet/balance', { body: { qr: s.qr } });
    check(`3 texto de muestra ${i + 1}`, r, s);
  }

  // 4. cargar() de la guía en `active`, y los topes en `empty`.
  await reset('4 reinicio');
  const { oxp } = await import(pathToFileURL(join(dir, 'oxp.mjs')).href);
  const { cargar, buscarPorReferencia } = await import(pathToFileURL(join(dir, 'cargar.mjs')).href);
  const tx = { id: `${id}-C1`, amount: 1000, qr: link('active'), inicio: new Date(), sinRespuesta: false };
  const first = await cargar(tx);
  if (first.accion !== 'cobrar') fail('4 cargar() nueva', null, `cobrar (dio ${first.accion} ${first.error ?? ''})`);
  log(`ok · 4 cargar() nueva → cobrar (${first.carga.id})`);
  const again = await cargar(tx);
  if (again.accion !== 'cobrar' || again.carga.id !== first.carga.id) fail('4 cargar() repetida', null, `cobrar la misma carga (dio ${again.accion})`);
  log('ok · 4 cargar() repetida → cobrar, la misma carga');
  const other = await cargar({ ...tx, amount: 1500 });
  if (other.accion !== 'devolver') fail('4 cargar() otro importe con la misma clave', null, `devolver (dio ${other.accion})`);
  log(`ok · 4 cargar() otro importe con la misma clave → devolver (${other.error})`);
  const found = await buscarPorReferencia(tx);
  if (typeof found !== 'object' || found.id !== first.carga.id) fail('4 buscarPorReferencia()', null, `la carga (dio ${typeof found === 'string' ? found : 'otra'})`);
  log('ok · 4 buscarPorReferencia() → la encuentra');

  const load = (key, qr, amount, funding = 'cash', extra = {}) =>
    oxp('POST', '/wallet/loads', {
      idempotencyKey: key,
      body: { qr, ...extra, amount, description: 'Recarga en cajero 0042', reference: key, funding, device: 'ATM0042' },
    });
  const card = await load(`${id}-T1`, link('active'), 1000, 'card');
  check('4 funding card', card, { status: 422, code: 'funding_not_allowed' });
  const e1 = await load(`${id}-E1`, link('empty'), 30000);
  check('4 empty 300 €', e1, { status: 201 });
  const e2 = await load(`${id}-E2`, link('empty'), 30000);
  check('4 empty 300 € otra vez', e2, { status: 201 });
  const e3 = await load(`${id}-E3`, link('empty'), 1);
  check('4 empty 0,01 €', e3, { status: 402, code: 'limit_exceeded' });
  if (e3.data.limit !== 'wallet_24h' || e3.data.remaining !== 0) fail('4 empty 0,01 € con wallet_24h y remaining 0', e3, 'wallet_24h, remaining 0');

  // 5. Anular dos veces (solo si esta noche hay menos de 2 anuladas: la 3.ª pausa las cargas).
  const tonight = await allOperations(call, { business_date: businessDate() });
  if (!tonight.ok) fail('5 /wallet/operations de esta noche', tonight.r, '200');
  const voided = tonight.data.filter((o) => o.status === 'voided').length;
  if (voided >= 2) {
    log(`salto · 5 anular: esta noche ya hay ${voided} cargas anuladas (la 3.ª pausaría las cargas)`);
  } else {
    const v0 = await load(`${id}-V1`, link('ficha_uid'), 5000, 'cash', { nfc_uid: storedUid });
    check('5 ficha_uid 50 €', v0, { status: 201 });
    const v1 = await call('POST', `/wallet/loads/${v0.data.id}/void`);
    check('5 anular', v1, { status: 200 });
    const v2 = await call('POST', `/wallet/loads/${v0.data.id}/void`);
    check('5 anular otra vez', v2, { status: 200 });
    if (v1.data.status !== 'voided' || v2.data.id !== v0.data.id || v2.data.status !== 'voided' || v2.data.voided_at !== v1.data.voided_at) {
      fail('5 la misma carga, voided', v2, 'la misma carga voided');
    }
  }

  // 6. /statement = /wallet/operations en el rato de la corrida.
  const window = { from: started.toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
  const ops = await allOperations(call, window);
  if (!ops.ok) fail('6 /wallet/operations de la corrida', ops.r, '200');
  const st = await call('GET', `/statement?${new URLSearchParams(window)}`);
  if (st.status !== 200) fail('6 /statement', st, '200');
  const sum = (list) => list.reduce((s, o) => s + o.amount, 0);
  const voids = ops.data.filter((o) => o.status === 'voided');
  const same =
    st.data.loads.count === ops.data.length &&
    st.data.loads.amount === sum(ops.data) &&
    st.data.load_voids.count === voids.length &&
    st.data.load_voids.amount === sum(voids) &&
    st.data.net_loads === sum(ops.data) - sum(voids);
  if (!same) fail('6 /statement igual a /wallet/operations', st, 'los mismos recuentos e importes');
  ok(`6 /statement igual a /wallet/operations (${ops.data.length} cargas)`, st);

  await reset('6 reinicio al acabar');
  log(`TODO BIEN · corrida ${id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log(`FALLO inesperado (${err?.name ?? 'Error'})`);
    process.exit(1);
  });
}
