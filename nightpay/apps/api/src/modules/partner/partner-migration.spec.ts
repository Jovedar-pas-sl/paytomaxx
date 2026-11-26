import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EEA_COUNTRIES, PARTNER_PAUSE_REASONS } from '@nightpay/contracts';

const MIGRATION = join(__dirname, '../../../../../packages/db/prisma/migrations/20261126100000_partner_core/migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const cargas = readFileSync(join(MIGRATION, '../../20261126200000_partner_cargas/migration.sql'), 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]!).sort();

describe('la migración de los socios y los contratos dicen lo mismo', () => {
  it('el CHECK partner_connections_paused_reason admite justo PARTNER_PAUSE_REASONS', () => {
    // El de partner_core, más amplio desde 20261126200000_partner_cargas (las pausas automáticas de las cargas).
    const check = /"partner_connections_paused_reason" CHECK \(([\s\S]*?)\)\s*\)/.exec(sql)?.[1] ?? '';
    const core = quoted(check.slice(check.indexOf(' IN ')));
    expect(core).toEqual(['foreign_ip', 'manager', 'owner', 'oxiopay']);
    const replaced = /'partner_connections_paused_reason',\s*'([^\n]*)'\);/.exec(cargas)?.[1] ?? '';
    const now = [...replaced.matchAll(/''([a-z_]+)''/g)].map((m) => m[1]!).sort();
    expect(now).toEqual([...PARTNER_PAUSE_REASONS].sort());
    expect(now).toEqual(expect.arrayContaining(core));
  });

  it('la lista del EEE de la migración es EEA_COUNTRIES', () => {
    const at = sql.indexOf("'AT'");
    const list = sql.slice(at, sql.indexOf(']', at));
    expect(quoted(list)).toEqual([...EEA_COUNTRIES].sort());
  });
});
