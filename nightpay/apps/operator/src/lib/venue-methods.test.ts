import { describe, expect, it } from 'vitest';
import { paymentMethodsOf } from '@nightpay/contracts';
import { canTopUp, cobroModeAllowed, myRightsOf, staffHomeHint, visibleTabsFor } from './venue-methods';

describe('formas de cobro del local en la app del personal', () => {
  it('sin ajustes: todo a la vista, como antes', () => {
    const all = paymentMethodsOf(null);
    expect((['qr', 'wallet', 'pos'] as const).every((m) => cobroModeAllowed(m, all))).toBe(true);
    expect(visibleTabsFor(['home', 'wallet', 'pos'], all)).toEqual(['home', 'wallet', 'pos']);
  });

  it('tarjeta apagada: sin QR; «Recargar saldo» solo en efectivo (si está encendido); el datáfono sigue', () => {
    const m = paymentMethodsOf({ card: false });
    expect(cobroModeAllowed('qr', m)).toBe(false);
    expect(cobroModeAllowed('wallet', m)).toBe(true);
    expect(cobroModeAllowed('wallet', paymentMethodsOf({ card: false, cashTopUp: false }))).toBe(false);
    expect(cobroModeAllowed('pos', m)).toBe(true);
  });

  it('saldo o datáfono apagados: fuera su pestaña y su modo', () => {
    const m = paymentMethodsOf({ wallet: false, pos: false });
    expect(cobroModeAllowed('wallet', m)).toBe(false);
    expect(cobroModeAllowed('pos', m)).toBe(false);
    expect(visibleTabsFor(['home', 'wallet', 'pos'], m)).toEqual(['home']);
    // Sin saldo, tampoco la recepción (recargar el saldo).
    expect(visibleTabsFor(['home', 'wallet', 'reception', 'pos'], m)).toEqual(['home']);
    expect(visibleTabsFor(['home', 'wallet', 'reception', 'pos'], paymentMethodsOf({ pos: false }))).toEqual(['home', 'wallet', 'reception']);
    expect(visibleTabsFor(['home', 'wallet', 'payments', 'earnings'], m)).toEqual(['home', 'payments', 'earnings']);
  });

  it('datáfono apagado: Inicio no habla de la cola «POS»', () => {
    expect(staffHomeHint(paymentMethodsOf(null))).toContain('«POS»');
    const off = staffHomeHint(paymentMethodsOf({ pos: false }));
    expect(off).toBe('Cobra aquí la barra, las habitaciones o la comida.');
    expect(off).not.toMatch(/datáfono|POS/);
  });
});

describe('solo recepción carga saldos (y cobra el efectivo)', () => {
  const recepcion = myRightsOf('RECEPCION', { sections: [], tips: false, cash: true, topUps: true });
  const barra = myRightsOf('BARRA', { sections: ['VENUE_BAR'], tips: true, cash: false, topUps: false });

  it('lo que puede, de /v1/venues/me (un API anterior no lo dice: null)', () => {
    expect(recepcion).toEqual({ post: 'RECEPCION', topUps: true, cash: true });
    expect(barra).toEqual({ post: 'BARRA', topUps: false, cash: false });
    expect(myRightsOf(null, null)).toBeNull();
    expect(myRightsOf('BARRA', { sections: [] })).toBeNull();
  });

  it('recepción, encargado y dueño ven «Recargar» y la pestaña Recepción; barra y la chica, no', () => {
    const all = paymentMethodsOf(null);
    const staffTabs = ['home', 'wallet', 'reception', 'pos'] as const;
    expect(canTopUp(recepcion, 'WAITER')).toBe(true);
    expect(canTopUp(barra, 'WAITER')).toBe(false);
    expect(visibleTabsFor(staffTabs, all, canTopUp(barra, 'WAITER'))).toEqual(['home', 'wallet', 'pos']);
    expect(visibleTabsFor(staffTabs, all, canTopUp(recepcion, 'WAITER'))).toEqual(['home', 'wallet', 'reception', 'pos']);
    expect(cobroModeAllowed('wallet', all, canTopUp(barra, 'WAITER'))).toBe(false);
    expect(cobroModeAllowed('wallet', all, canTopUp(recepcion, 'WAITER'))).toBe(true);
    // El QR y el datáfono no dependen de cargar saldos.
    expect(cobroModeAllowed('qr', all, false)).toBe(true);
  });

  it('sin saberlo aún: el personal sí (el servidor decide igual) y la chica no', () => {
    expect(canTopUp(null, 'WAITER')).toBe(true);
    expect(canTopUp(null, 'MANAGER')).toBe(true);
    expect(canTopUp(null, 'OPERATOR')).toBe(false);
  });
});
