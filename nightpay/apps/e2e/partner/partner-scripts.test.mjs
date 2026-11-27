// Pruebas de los guiones de la demo (PR 8 B): demo-check.mjs y carga.mjs se
// niegan con una clave real antes de hacer ninguna petición y sin escribirla,
// el id de cada corrida tiene su forma y el extractor encuentra el código de
// las guías. node --test apps/e2e/partner/ (sin dependencias).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsBlocks, runId } from './demo-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDES = join(HERE, '../../../docs/partner-api/guides/es');
const LIVE_KEY = 'oxp_live_0123456789abcdef0123456789abcdef0123456789abcdef';

/** Un servidor que cuenta lo que le llega y nunca contesta (una dirección que no responde). */
async function silentServer() {
  const seen = [];
  const server = createServer((req) => seen.push(req.url));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { seen, base: `http://127.0.0.1:${server.address().port}/v1/partner`, close: () => server.close() };
}

function run(script, env) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [join(HERE, script)], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      ok({ code, out });
    });
  });
}

for (const script of ['demo-check.mjs', 'carga.mjs']) {
  test(`${script}: con una clave oxp_live_ sale con 1 antes de ninguna petición y no la escribe`, async () => {
    const srv = await silentServer();
    try {
      const { code, out } = await run(script, { OXP_KEY: LIVE_KEY, OXP_BASE: srv.base, MINUTOS: '1' });
      assert.equal(code, 1);
      assert.equal(srv.seen.length, 0, 'hizo una petición');
      assert.ok(!out.includes(LIVE_KEY), 'la clave salió en la salida');
      assert.ok(!out.includes('0123456789abcdef'), 'un trozo de la clave salió en la salida');
      assert.match(out, /oxp_test_/);
    } finally {
      srv.close();
    }
  });

  test(`${script}: sin clave, o con otra que no es oxp_test_, también se niega sin llamar`, async () => {
    const srv = await silentServer();
    try {
      for (const key of [undefined, 'sk_live_abc', 'oxp_tes_x']) {
        const env = { OXP_BASE: srv.base, MINUTOS: '1' };
        if (key !== undefined) env.OXP_KEY = key;
        const { code } = await run(script, env);
        assert.equal(code, 1, String(key));
      }
      assert.equal(srv.seen.length, 0);
    } finally {
      srv.close();
    }
  });
}

test('el id de cada corrida: DEMOCHK-<AAAAMMDDhhmmss>-<4 al azar>, distinto cada vez', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const id = runId();
    assert.match(id, /^DEMOCHK-\d{14}-[A-Z0-9]{4}$/);
    ids.add(id);
  }
  assert.ok(ids.size > 45);
});

test('el id nunca lleva 14 cifras que pasen Luhn (la API lo tomaría por una tarjeta en `reference`)', () => {
  const luhn = (digits) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  };
  for (let s = 0; s < 40; s++) {
    const id = runId(new Date(Date.UTC(2026, 11, 5, 22, 41, s)));
    assert.equal(luhn(id.slice(8, 22)), false, id);
  }
});

test('el extractor encuentra oxp.mjs y tres-llamadas.mjs en es/01, y cargar.mjs en es/04', () => {
  const c1 = extractJsBlocks(readFileSync(join(GUIDES, '01-empieza.md'), 'utf8'));
  const c4 = extractJsBlocks(readFileSync(join(GUIDES, '04-cargar-saldo.md'), 'utf8'));
  assert.deepEqual([...c1.keys()], ['oxp.mjs', 'tres-llamadas.mjs']);
  assert.deepEqual([...c4.keys()], ['cargar.mjs']);
  assert.match(c1.get('oxp.mjs'), /export async function oxp\(/);
  assert.match(c4.get('cargar.mjs'), /export async function cargar\(/);
  assert.match(c4.get('cargar.mjs'), /export async function buscarPorReferencia\(/);
});
