#!/usr/bin/env node
// audit-gate — corta CI si las dependencias de producción tienen
// vulnerabilidades críticas o altas que no estén aceptadas, con fecha de
// caducidad, en .audit-allowlist.json.
//
//   node scripts/audit-gate.mjs                 (lanza `pnpm audit --prod --json`)
//   node scripts/audit-gate.mjs --input a.json  (evalúa un informe ya guardado)
//
// Sale con 1 si hay alguna crítica/alta sin aceptar, o aceptada pero caducada.
// Las moderadas y bajas solo se cuentan.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEVERE = new Set(['critical', 'high']);

function fail(msg) {
  console.error(`[audit-gate] ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadReport() {
  const input = arg('--input');
  const raw = input
    ? readFileSync(input, 'utf8')
    : (() => {
        const r = spawnSync('pnpm', ['audit', '--prod', '--json'], {
          cwd: root,
          encoding: 'utf8',
          shell: process.platform === 'win32',
          maxBuffer: 64 * 1024 * 1024,
        });
        // pnpm audit sale con 1 cuando encuentra algo: lo que cuenta es el JSON.
        if (!r.stdout?.trim()) fail(`pnpm audit no devolvió nada (¿sin red?)\n${r.stderr ?? r.error?.message ?? ''}`);
        return r.stdout;
      })();
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    fail(`el informe de pnpm audit no es JSON:\n${raw.slice(0, 500)}`);
  }
  if (report.error) fail(`pnpm audit falló: ${JSON.stringify(report.error)}`);
  return report;
}

function loadAllowlist() {
  const file = join(root, '.audit-allowlist.json');
  const entries = JSON.parse(readFileSync(file, 'utf8')).advisories ?? [];
  for (const e of entries) {
    if (!e.id || !e.package || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '')) {
      fail(`entrada incompleta en .audit-allowlist.json (hacen falta id, package, reason y expires AAAA-MM-DD): ${JSON.stringify(e)}`);
    }
  }
  return entries;
}

const report = loadReport();
const allow = loadAllowlist();
const byId = new Map(allow.map((e) => [e.id, e]));
const today = new Date().toISOString().slice(0, 10);

const blocked = [];
const expired = [];
const accepted = [];
const seen = new Set();
const minor = { moderate: 0, low: 0, info: 0 };

for (const [npmId, adv] of Object.entries(report.advisories ?? {})) {
  if (!SEVERE.has(adv.severity)) {
    minor[adv.severity] = (minor[adv.severity] ?? 0) + 1;
    continue;
  }
  const id = adv.github_advisory_id ?? npmId;
  const entry = byId.get(id) ?? byId.get(String(npmId));
  const line = `${adv.severity.padEnd(8)} ${adv.module_name} ${id} — ${String(adv.title).trim()} (arreglado en ${adv.patched_versions})`;
  if (!entry) {
    blocked.push(line);
    continue;
  }
  seen.add(entry.id);
  if (entry.expires < today) expired.push(`${line}\n           aceptada hasta ${entry.expires}: ${entry.reason}`);
  else accepted.push(line);
}

const stale = allow.filter((e) => !seen.has(e.id));

console.log(
  `[audit-gate] críticas/altas: ${blocked.length + expired.length + accepted.length} ` +
    `(${accepted.length} aceptadas en .audit-allowlist.json) · ` +
    `moderadas: ${minor.moderate} · bajas: ${minor.low}`,
);
for (const e of stale) {
  console.warn(`[audit-gate] aviso: ${e.id} (${e.package}) ya no sale en pnpm audit: quítala de .audit-allowlist.json`);
}
if (expired.length > 0) {
  console.error(`\n[audit-gate] ACEPTADAS PERO CADUCADAS (${expired.length}): actualiza la dependencia o revisa la fecha.\n`);
  for (const l of expired) console.error(`  ${l}`);
}
if (blocked.length > 0) {
  console.error(`\n[audit-gate] SIN ACEPTAR (${blocked.length}):\n`);
  for (const l of blocked) console.error(`  ${l}`);
  console.error(
    '\nArréglalas (subir la dependencia o un "pnpm.overrides" en package.json) o, si de verdad no se puede ya,' +
      '\nañádelas a .audit-allowlist.json con el motivo y una fecha de caducidad.',
  );
}
if (blocked.length > 0 || expired.length > 0) process.exit(1);
console.log('[audit-gate] OK');
