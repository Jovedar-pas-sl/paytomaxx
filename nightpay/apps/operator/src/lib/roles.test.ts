import { describe, expect, it } from 'vitest';
import { canOpenTab, roleAccess } from './roles';

describe('qué ve cada rol', () => {
  it('la chica: su saldo y su noche, sus cobros y sus ganancias; sin cola POS', () => {
    const access = roleAccess('OPERATOR');
    expect(access.tabs).toEqual(['home', 'wallet', 'payments', 'earnings']);
    expect(access.ownEarnings).toBe(true);
    expect(access.ownPayments).toBe(true);
    expect(access.posQueue).toBe(false);
  });

  it.each(['WAITER', 'MANAGER', 'OWNER'] as const)(
    '%s: cobra y confirma el datáfono; nada de /operators/me ni /nights/mine (el API da 403)',
    (role) => {
      const access = roleAccess(role);
      expect(access.tabs).toEqual(['home', 'wallet', 'pos']);
      expect(access.ownEarnings).toBe(false);
      expect(access.ownPayments).toBe(false);
      expect(access.posQueue).toBe(true);
    },
  );

  it('una pestaña que el rol no tiene no se abre', () => {
    expect(canOpenTab('WAITER', 'earnings')).toBe(false);
    expect(canOpenTab('WAITER', 'payments')).toBe(false);
    expect(canOpenTab('OPERATOR', 'pos')).toBe(false);
    expect(canOpenTab('MANAGER', 'pos')).toBe(true);
    expect(canOpenTab('OPERATOR', 'earnings')).toBe(true);
  });
});
