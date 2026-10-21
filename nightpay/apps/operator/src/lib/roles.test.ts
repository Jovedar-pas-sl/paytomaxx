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
    '%s: cobra y confirma el datáfono; historial propio; sin ganancias de chica ni /nights/mine',
    (role) => {
      const access = roleAccess(role);
      expect(access.tabs).toEqual(['home', 'wallet', 'payments', 'reception', 'pos']);
      expect(access.ownEarnings).toBe(false);
      expect(access.ownPayments).toBe(true);
      expect(access.posQueue).toBe(true);
    },
  );

  it('una pestaña que el rol no tiene no se abre', () => {
    expect(canOpenTab('WAITER', 'earnings')).toBe(false);
    expect(canOpenTab('WAITER', 'payments')).toBe(true);
    expect(canOpenTab('OPERATOR', 'pos')).toBe(false);
    // La recepción es del personal: la chica no recarga saldos ni prepara fichas.
    expect(canOpenTab('OPERATOR', 'reception')).toBe(false);
    expect(canOpenTab('WAITER', 'reception')).toBe(true);
    expect(canOpenTab('MANAGER', 'pos')).toBe(true);
    expect(canOpenTab('OPERATOR', 'earnings')).toBe(true);
  });
});
