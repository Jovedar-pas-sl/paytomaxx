import { describe, expect, it } from 'vitest';
import { canOpenTab, roleAccess } from './roles';

describe('qué ve cada rol', () => {
  it('la chica: cobrar (Inicio, la única pantalla de cobrar), sus cobros y sus ganancias; sin cola POS', () => {
    const access = roleAccess('OPERATOR');
    expect(access.tabs).toEqual(['home', 'payments', 'earnings']);
    expect(access.ownEarnings).toBe(true);
    expect(access.ownPayments).toBe(true);
    expect(access.posQueue).toBe(false);
  });

  it.each(['WAITER', 'MANAGER', 'OWNER'] as const)(
    '%s: cobra y confirma el datáfono; historial propio; sin ganancias de chica ni /nights/mine',
    (role) => {
      const access = roleAccess(role);
      expect(access.tabs).toEqual(['home', 'payments', 'reception', 'reservas', 'pos']);
      expect(access.ownEarnings).toBe(false);
      expect(access.ownPayments).toBe(true);
      expect(access.posQueue).toBe(true);
    },
  );

  it('la chica, en «Cobros» (la lista del panel): cancela ahí sus cobros sin pagar y se refresca cada 5 s, como su lista de antes', () => {
    expect(roleAccess('OPERATOR').history).toEqual({ cancelPending: true, pollMs: 5000 });
  });

  it.each(['WAITER', 'MANAGER', 'OWNER'] as const)('%s, en «Cobros»: la misma lista, solo para mirar, cada 15 s', (role) => {
    expect(roleAccess(role).history).toEqual({ cancelPending: false, pollMs: 15_000 });
  });

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
