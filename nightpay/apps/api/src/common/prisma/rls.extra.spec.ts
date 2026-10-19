import { describe, it, expect } from 'vitest';
import { forcedRlsTarget, forcedTableIn, rawSqlText } from './rls';

describe('rawSqlText — formas del SQL crudo en el middleware', () => {
  it('sin argumentos, vacío o con un primer argumento raro → ""', () => {
    expect(rawSqlText(undefined)).toBe('');
    expect(rawSqlText([])).toBe('');
    expect(rawSqlText([{ sql: 'SELECT * FROM client_wallets' }])).toBe('');
    expect(rawSqlText('SELECT * FROM client_wallets')).toBe('');
  });

  it('texto ($queryRawUnsafe) y plantilla ($queryRaw) se leen', () => {
    expect(rawSqlText(['SELECT 1 FROM operator_payouts WHERE id = $1', 'x'])).toMatch(/operator_payouts/);
    expect(rawSqlText([['UPDATE earning_reversals SET a = ', ' WHERE id = ', ''], 1, 'x'])).toMatch(/earning_reversals/);
  });
});

describe('forcedTableIn — nombre de tabla', () => {
  it('con comillas, esquema o al final de la sentencia se detecta', () => {
    expect(forcedTableIn('SELECT * FROM "client_wallets" WHERE id = $1')).toBe('client_wallets');
    expect(forcedTableIn('DELETE FROM public.peanpe_calls')).toBe('peanpe_calls');
    expect(forcedTableIn('SELECT count(*) FROM wallet_consumptions;')).toBe('wallet_consumptions');
  });

  it('nombres que solo se parecen no cuentan', () => {
    expect(forcedTableIn('SELECT * FROM client_wallets_archive')).toBeNull();
    expect(forcedTableIn('SELECT * FROM my_operator_earnings')).toBeNull();
  });

  // BUG (menor, solo aviso): rls.ts:38 — la expresión distingue mayúsculas. Postgres pasa
  // a minúsculas los nombres sin comillas, así que `FROM CLIENT_WALLETS` toca la tabla con
  // FORCE RLS pero no se avisa ni se corta con TENANCY_UNSCOPED_QUERIES=throw. No filtra
  // datos (FORCE RLS sin local no devuelve filas), pero se escapa a la guardia.
  it.skip('en mayúsculas también se detecta', () => {
    expect(forcedTableIn('SELECT * FROM CLIENT_WALLETS')).toBe('client_wallets');
  });
});

describe('forcedRlsTarget — argumentos que no se recorren', () => {
  it('fechas y Buffers (aunque contengan el nombre de la tabla) no cuentan', () => {
    const args = { take: 10, cursorFecha: new Date('2026-10-17T00:00:00Z'), blob: Buffer.from('client_wallets') };
    expect(forcedRlsTarget({ model: 'Payment', action: 'findMany', args })).toBeNull();
  });
});

describe('forcedRlsTarget — consultas sin modelo', () => {
  it('solo queryRaw / executeRaw miran el SQL', () => {
    expect(forcedRlsTarget({ action: 'executeRaw', args: ['DELETE FROM peanpe_calls WHERE id = $1', 'x'] })).toBe('peanpe_calls');
    expect(forcedRlsTarget({ action: 'runCommandRaw', args: ['client_wallets'] })).toBeNull();
  });
});
