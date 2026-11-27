#!/usr/bin/env node
// Prueba de carga de la demo (PR 8 B, B4). Node 22, sin dependencias. A mano,
// desde España, con la clave de «Pruebas OxioPay», una vez por noche y nunca a
// la vez que demo-check.mjs:
//
//   OXP_KEY=oxp_test_… OXP_BASE=https://<demo-api>/v1/partner MINUTOS=10 node apps/e2e/partner/carga.mjs
//
// Durante MINUTOS (10 si no se da): 8 lecturas de saldo por segundo
// repartidas por igual entre las FICHAS fichas demo-carga-* (300 si no se da,
// las de la semilla) y, a la vez, 25 cargas de 1,00 € por minuto (device
// CARGA01, sin anular), empezando cuando la conexión lleva 65 s sin cargas
// (más de 30 en un minuto la pausarían). Después, reinicio y 6 cargas de 300 € a la vez en
// `empty`. Pasa con: cero 5xx y 429, p95 < 300 ms por ruta, en la ráfaga justo
// dos 201 y cuatro 402 limit_exceeded (wallet_24h), paused_scopes vacío y
// /statement igual a la suma de sus 201. Nunca escribe la clave ni un saldo.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allOperations, guardEnv, makeClient, makeLog, percentile } from './comun.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const log = makeLog('carga');

const READS_PER_SECOND = 8;
const LOADS_PER_MINUTE = 25;
const BURST = 6; // el máximo de cargas por saldo y minuto
const FICHA_NIGHT_READS = 20; // lecturas con ficha por saldo y noche
const P95_MAX_MS = 300;
// Más de 30 cargas nuevas en un minuto pausan las cargas de la conexión: se
// empieza cuando la última carga (de demo-check, por ejemplo) tiene ya 65 s.
const QUIET_MS = 65_000;

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    log(`${name} es un número de ${min} a ${max}.`);
    process.exit(1);
  }
  return Number(raw);
}

async function main() {
  const env = guardEnv(process.env, log);
  const minutes = intEnv('MINUTOS', 10, 1, 60);
  const fichas = intEnv('FICHAS', 300, 1, 500);
  const perFicha = Math.ceil((READS_PER_SECOND * 60 * minutes) / fichas);
  if (perFicha > FICHA_NIGHT_READS) {
    log(`${perFicha} lecturas por ficha pasan de las ${FICHA_NIGHT_READS} por noche: menos MINUTOS o más FICHAS.`);
    process.exit(1);
  }
  const call = makeClient(env);
  const fx = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
  const cargaLink = (i) => `${fx.link}demo-carga-${String((i % fichas) + 1).padStart(6, '0')}`;
  const prefix = `CARGA-${Date.now().toString(36).toUpperCase()}`;

  const me = await call('GET', '/me');
  if (me.status !== 200 || me.data?.livemode !== false) {
    log(`FALLO · GET /me con livemode false → ${me.status} · Request-Id ${me.requestId}`);
    process.exit(1);
  }
  const recent = await allOperations(call, { from: new Date(Date.now() - 2 * 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
  if (!recent.ok) {
    log(`FALLO · /wallet/operations de los últimos minutos → ${recent.r.status} · Request-Id ${recent.r.requestId}`);
    process.exit(1);
  }
  const last = Math.max(0, ...recent.data.map((o) => Date.parse(o.created_at)));
  const wait = last + QUIET_MS - Date.now();
  if (wait > 0) {
    log(`espero ${Math.ceil(wait / 1000)} s: hay cargas de hace menos de un minuto`);
    await new Promise((done) => setTimeout(done, wait));
  }
  const started = new Date();
  log(`${minutes} min · ${READS_PER_SECOND} lecturas/s entre ${fichas} fichas (${perFicha} por ficha) · ${LOADS_PER_MINUTE} cargas/min`);

  /** ruta → { ms: [], status: Map<estado, n> } */
  const stats = new Map();
  const note = (route, r) => {
    const s = stats.get(route) ?? { ms: [], status: new Map() };
    stats.set(route, s);
    s.ms.push(r.ms);
    const key = r.data?.limit ? `${r.status} ${r.data.code}/${r.data.limit}` : r.data?.code && /^[a-z_]+$/.test(r.data.code) ? `${r.status} ${r.data.code}` : String(r.status);
    s.status.set(key, (s.status.get(key) ?? 0) + 1);
    return r;
  };
  const created = [];
  const inflight = new Set();
  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };

  let reads = 0;
  let loads = 0;
  const readTimer = setInterval(() => {
    const i = reads++;
    track(call('POST', '/wallet/balance', { body: { qr: cargaLink(i) } }).then((r) => note('POST /wallet/balance', r)));
  }, 1000 / READS_PER_SECOND);
  const loadTimer = setInterval(() => {
    const n = loads++;
    const key = `${prefix}-${n}`;
    // Otra ficha que la de las lecturas de ese momento: la mitad de la vuelta más allá.
    const body = { qr: cargaLink(n + Math.floor(fichas / 2)), amount: 100, description: 'Prueba de carga', reference: key, funding: 'cash', device: 'CARGA01' };
    track(
      call('POST', '/wallet/loads', { body, idem: key }).then((r) => {
        note('POST /wallet/loads', r);
        if (r.status === 201) created.push(r.data.amount);
      }),
    );
  }, 60_000 / LOADS_PER_MINUTE);
  await new Promise((done) => setTimeout(done, minutes * 60_000));
  clearInterval(readTimer);
  clearInterval(loadTimer);
  await Promise.allSettled([...inflight]);

  // La ráfaga: 6 cargas de 300 € a la vez en `empty`, recién reiniciada.
  const reset = note('POST /test/fixtures/reset', await call('POST', '/test/fixtures/reset'));
  const burst = await Promise.all(
    Array.from({ length: BURST }, (_, k) => {
      const key = `${prefix}-R${k}`;
      const body = { qr: fx.link + fx.fixtures.empty.token, amount: 30000, description: 'Prueba de carga', reference: key, funding: 'cash', device: 'CARGA01' };
      return call('POST', '/wallet/loads', { body, idem: key }).then((r) => note('POST /wallet/loads (ráfaga)', r));
    }),
  );
  for (const r of burst) if (r.status === 201) created.push(r.data.amount);

  const after = note('GET /me', await call('GET', '/me'));
  const window = new URLSearchParams({ from: started.toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
  const st = note('GET /statement', await call('GET', `/statement?${window}`));

  // El informe: p50, p95 y p99 por ruta, y los estados.
  const problems = [];
  for (const [route, s] of stats) {
    const p = (q) => `${Math.round(percentile(s.ms, q))} ms`;
    const statuses = [...s.status].map(([k, n]) => `${k}×${n}`).join(', ');
    log(`${route}: n=${s.ms.length} · p50 ${p(50)} · p95 ${p(95)} · p99 ${p(99)} · ${statuses}`);
    if (percentile(s.ms, 95) >= P95_MAX_MS) problems.push(`${route}: p95 ${p(95)} (tope ${P95_MAX_MS} ms)`);
    for (const [k, n] of s.status) {
      const code = Number(k.split(' ')[0]);
      if (code === 0 || code >= 500 || code === 429) problems.push(`${route}: ${k}×${n}`);
    }
  }
  const only = (route, wanted) => {
    const s = stats.get(route);
    const other = s ? [...s.status].filter(([k]) => k !== wanted) : [];
    if (!s || other.length) problems.push(`${route}: todo tiene que ser ${wanted} (${other.map(([k, n]) => `${k}×${n}`).join(', ') || 'ninguna llamada'})`);
  };
  only('POST /wallet/balance', '200');
  only('POST /wallet/loads', '201');
  if (reset.status !== 204) problems.push(`reinicio → ${reset.status} · Request-Id ${reset.requestId}`);
  const n201 = burst.filter((r) => r.status === 201).length;
  const n402 = burst.filter((r) => r.status === 402 && r.data?.code === 'limit_exceeded' && r.data?.limit === 'wallet_24h').length;
  if (n201 !== 2 || n402 !== 4) problems.push(`ráfaga: ${n201}×201 y ${n402}×402 wallet_24h (tienen que ser 2 y 4)`);
  if (after.status !== 200 || !Array.isArray(after.data?.paused_scopes) || after.data.paused_scopes.length) {
    problems.push(`GET /me → ${after.status}, paused_scopes no vacío · Request-Id ${after.requestId}`);
  }
  const total = created.reduce((a, b) => a + b, 0);
  if (st.status !== 200 || st.data.loads.count !== created.length || st.data.loads.amount !== total || st.data.load_voids.count !== 0 || st.data.net_loads !== total) {
    problems.push(`/statement → ${st.status}, distinto de la suma de los ${created.length} 201 · Request-Id ${st.requestId}`);
  }

  if (problems.length) {
    for (const p of problems) log(`FALLO · ${p}`);
    process.exit(1);
  }
  log(`TODO BIEN · ${created.length} cargas creadas, /statement igual`);
}

main().catch((err) => {
  log(`FALLO inesperado (${err?.name ?? 'Error'})`);
  process.exit(1);
});
