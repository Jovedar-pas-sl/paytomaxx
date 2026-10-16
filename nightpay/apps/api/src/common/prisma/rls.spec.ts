import { describe, it, expect } from 'vitest';
import { FORCED_RLS_MODELS, FORCED_RLS_TABLES, forcedRlsTarget, forcedTableIn, rawSqlText } from './rls';

describe('tablas con FORCE RLS', () => {
  it('las de las migraciones (y sus modelos)', () => {
    expect([...FORCED_RLS_TABLES].sort()).toEqual([
      'approval_requests',
      'client_wallets',
      'earning_reversals',
      'operator_earnings',
      'operator_payouts',
      'peanpe_calls',
      'wallet_consumptions',
    ]);
    expect([...FORCED_RLS_MODELS].sort()).toEqual([
      'ApprovalRequest',
      'ClientWallet',
      'EarningReversal',
      'OperatorEarning',
      'OperatorPayout',
      'PeanpeCall',
      'WalletConsumption',
    ]);
  });

  it('el SQL crudo: plantilla o texto, nombre completo de la tabla', () => {
    expect(rawSqlText([['SELECT 1 FROM operator_earnings WHERE id = ', '::uuid'], 'x'])).toContain('operator_earnings');
    expect(rawSqlText(['SELECT 2 FROM client_wallets WHERE id = $1', 'x'])).toContain('client_wallets');
    expect(rawSqlText(undefined)).toBe('');
    expect(forcedTableIn('SELECT * FROM earning_reversals er')).toBe('earning_reversals');
    expect(forcedTableIn('SELECT * FROM my_operator_earnings_view')).toBeNull();
    expect(forcedTableIn('SELECT * FROM wallet_payouts')).toBeNull();
  });
});

describe('forcedRlsTarget', () => {
  it('modelo con FORCE RLS', () => {
    expect(forcedRlsTarget({ model: 'OperatorPayout', action: 'findMany', args: {} })).toBe('OperatorPayout');
    expect(forcedRlsTarget({ model: 'PeanpeCall', action: 'create', args: { data: {} } })).toBe('PeanpeCall');
    expect(forcedRlsTarget({ model: 'ApprovalRequest', action: 'findMany', args: {} })).toBe('ApprovalRequest');
  });

  it('otro modelo que llega a una de ellas por una relación (include, select, _count, filtro)', () => {
    expect(forcedRlsTarget({ model: 'Payment', action: 'findUnique', args: { include: { peanpeCall: true } } })).toBe(
      'Payment (relación)',
    );
    expect(
      forcedRlsTarget({ model: 'Payment', action: 'findMany', args: { select: { wallet: { select: { qrToken: true } } } } }),
    ).toBe('Payment (relación)');
    expect(
      forcedRlsTarget({ model: 'User', action: 'findMany', args: { select: { _count: { select: { earnings: true } } } } }),
    ).toBe('User (relación)');
    expect(forcedRlsTarget({ model: 'User', action: 'findMany', args: { where: { payouts: { some: {} } } } })).toBe(
      'User (relación)',
    );
    // A través de otra relación: cobro → intentos no, cobro → creador → sus comisiones sí.
    expect(
      forcedRlsTarget({ model: 'Payment', action: 'findFirst', args: { include: { createdBy: { include: { earnings: true } } } } }),
    ).toBe('Payment (relación)');
  });

  it('sin tocarlas: modelos por local normales, escalares y JSON con nombres parecidos', () => {
    expect(forcedRlsTarget({ model: 'Payment', action: 'findMany', args: { where: { walletId: 'w', status: 'AUTHORIZED' } } })).toBeNull();
    expect(forcedRlsTarget({ model: 'Payment', action: 'findMany', args: { include: { attempts: true }, orderBy: [{ createdAt: 'desc' }] } })).toBeNull();
    expect(forcedRlsTarget({ model: 'AuditEvent', action: 'create', args: { data: { payload: { wallet: 'x', earnings: [1] } } } })).toBeNull();
    expect(forcedRlsTarget({ model: 'Payment', action: 'findMany', args: { where: { createdAt: { gte: new Date() } } } })).toBeNull();
  });

  it('SQL crudo: solo queryRaw / executeRaw que nombran una de ellas', () => {
    expect(forcedRlsTarget({ action: 'queryRaw', args: [['SELECT 1 FROM peanpe_calls']] })).toBe('peanpe_calls');
    expect(forcedRlsTarget({ action: 'executeRaw', args: ["UPDATE operator_payouts SET notes = 'x'"] })).toBe('operator_payouts');
    expect(forcedRlsTarget({ action: 'queryRaw', args: [['SELECT 1 FROM payments']] })).toBeNull();
    expect(forcedRlsTarget({ action: 'runCommandRaw', args: [{ x: 'client_wallets' }] })).toBeNull();
  });
});
