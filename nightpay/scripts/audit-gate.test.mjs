// node --test scripts/audit-gate.test.mjs
// El corte de CI por vulnerabilidades: con una crítica o alta sin aceptar (o
// aceptada pero caducada) sale con 1 y la CI se pone en rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const gate = join(dirname(fileURLToPath(import.meta.url)), 'audit-gate.mjs');

function advisory(id, severity, module = 'paquete') {
  return { github_advisory_id: id, severity, module_name: module, title: `fallo ${id}`, patched_versions: '>=9.9.9' };
}

async function run(report, advisories = []) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-gate-'));
  try {
    const input = join(dir, 'audit.json');
    const allow = join(dir, 'allow.json');
    await writeFile(input, JSON.stringify(report));
    await writeFile(allow, JSON.stringify({ advisories }));
    const r = spawnSync(process.execPath, [gate, '--input', input, '--allowlist', allow], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const future = '2999-12-31';
const past = '2000-01-01';

test('una alta sin aceptar corta la CI', async () => {
  const r = await run({ advisories: { 1: advisory('GHSA-aaaa', 'high', 'zod') } });
  assert.equal(r.code, 1);
  assert.match(r.out, /SIN ACEPTAR \(1\)/);
  assert.match(r.out, /zod GHSA-aaaa/);
});

test('una crítica sin aceptar corta la CI', async () => {
  const r = await run({ advisories: { 7: advisory('GHSA-cccc', 'critical') } });
  assert.equal(r.code, 1);
});

test('aceptada con motivo y fecha: pasa', async () => {
  const r = await run({ advisories: { 1: advisory('GHSA-aaaa', 'high', 'zod') } }, [
    { id: 'GHSA-aaaa', package: 'zod', reason: 'inalcanzable', expires: future },
  ]);
  assert.equal(r.code, 0);
  assert.match(r.out, /\[audit-gate\] OK/);
});

test('aceptada pero caducada: corta otra vez', async () => {
  const r = await run({ advisories: { 1: advisory('GHSA-aaaa', 'high') } }, [
    { id: 'GHSA-aaaa', package: 'paquete', reason: 'inalcanzable', expires: past },
  ]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CADUCADAS/);
});

test('una aceptada no tapa otra alta distinta', async () => {
  const r = await run(
    { advisories: { 1: advisory('GHSA-aaaa', 'high'), 2: advisory('GHSA-bbbb', 'high', 'undici') } },
    [{ id: 'GHSA-aaaa', package: 'paquete', reason: 'inalcanzable', expires: future }],
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /undici GHSA-bbbb/);
});

test('moderadas y bajas solo se cuentan', async () => {
  const r = await run({ advisories: { 1: advisory('GHSA-m', 'moderate'), 2: advisory('GHSA-l', 'low') } });
  assert.equal(r.code, 0);
  assert.match(r.out, /moderadas: 1 · bajas: 1/);
});

test('entrada incompleta en la lista o informe con error: corta (no se da por bueno)', async () => {
  const incomplete = await run({ advisories: {} }, [{ id: 'GHSA-aaaa', package: 'zod' }]);
  assert.equal(incomplete.code, 1);
  const failed = await run({ error: { code: 'ENOTFOUND' } });
  assert.equal(failed.code, 1);
});
