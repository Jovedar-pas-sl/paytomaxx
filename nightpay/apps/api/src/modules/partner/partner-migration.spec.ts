import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EEA_COUNTRIES, PARTNER_PAUSE_REASONS } from '@nightpay/contracts';

const MIGRATION = join(__dirname, '../../../../../packages/db/prisma/migrations/20261126100000_partner_core/migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]!).sort();

describe('la migración de los socios y los contratos dicen lo mismo', () => {
  it('el CHECK partner_connections_paused_reason admite justo PARTNER_PAUSE_REASONS', () => {
    const check = /"partner_connections_paused_reason" CHECK \(([\s\S]*?)\)\s*\)/.exec(sql)?.[1] ?? '';
    expect(quoted(check.slice(check.indexOf(' IN ')))).toEqual([...PARTNER_PAUSE_REASONS].sort());
  });

  it('la lista del EEE de la migración es EEA_COUNTRIES', () => {
    const at = sql.indexOf("'AT'");
    const list = sql.slice(at, sql.indexOf(']', at));
    expect(quoted(list)).toEqual([...EEA_COUNTRIES].sort());
  });
});
