// Lo común de demo-check.mjs y carga.mjs (Node 22, sin dependencias): la
// negativa a una clave que no sea de prueba, la llamada y los percentiles.
// Nunca se escribe la clave, un código OXC1:, un saldo ni un cuerpo de
// respuesta: solo el paso, el estado HTTP, el `code` del error y el Request-Id.

/** Escribe una línea con el nombre del guion delante. */
export function makeLog(name) {
  return (...parts) => console.log(`[${name}]`, ...parts);
}

/**
 * La clave y la dirección de OXP_KEY y OXP_BASE, o sale con 1 sin llamar a
 * nadie: solo claves `oxp_test_` y solo https (http solo a esta máquina).
 */
export function guardEnv(env, log) {
  const key = env.OXP_KEY ?? '';
  const base = (env.OXP_BASE ?? '').replace(/\/+$/, '');
  if (!key.startsWith('oxp_test_')) {
    log(key.startsWith('oxp_live_') ? 'Clave real: me niego. Solo claves de prueba (oxp_test_…), solo contra la demo.' : 'OXP_KEY tiene que ser una clave de prueba (oxp_test_…).');
    process.exit(1);
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    log('OXP_BASE no es una dirección (…/v1/partner de la demo).');
    process.exit(1);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    log('OXP_BASE tiene que ser https (http solo a esta máquina).');
    process.exit(1);
  }
  return { key, base };
}

/** call(method, path, { body, idem }) → { status, data, requestId, ms }; sin respuesta, status 0. */
export function makeClient({ key, base }) {
  return async function call(method, path, { body, idem } = {}) {
    const headers = { Authorization: `Bearer ${key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idem) headers['Idempotency-Key'] = idem;
    const t0 = performance.now();
    try {
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* 204, o sin JSON */
      }
      return { status: res.status, data, requestId: res.headers.get('request-id') ?? '-', ms: performance.now() - t0 };
    } catch {
      return { status: 0, data: null, requestId: '-', ms: performance.now() - t0 };
    }
  };
}

/** Percentil por rango más cercano (p en 0–100) de una lista de milisegundos. */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** ¿Pasan la prueba de Luhn estas cifras? (13 a 19 seguidas en `reference` = tarjeta → 422). */
export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** 4 letras o cifras al azar (mayúsculas). */
export function random4() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => abc[b % abc.length]).join('');
}

/** La noche del local (08:00 a 08:00 de Madrid) que contiene `now`, como AAAA-MM-DD. */
export function businessDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 8) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Todas las cargas de /wallet/operations con esa consulta (pasando por el cursor). */
export async function allOperations(call, query) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ ...query, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const r = await call('GET', `/wallet/operations?${q}`);
    if (r.status !== 200) return { ok: false, r };
    out.push(...r.data.data);
    if (!r.data.has_more) return { ok: true, data: out, r };
    cursor = r.data.next_cursor;
  }
  return { ok: false, r: { status: 0, requestId: '-' } };
}
