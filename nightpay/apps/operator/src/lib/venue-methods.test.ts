import { describe, expect, it } from 'vitest';
import { paymentMethodsOf } from '@nightpay/contracts';
import { cobroModeAllowed, staffHomeHint, visibleTabsFor } from './venue-methods';

describe('formas de cobro del local en la app del personal', () => {
  it('sin ajustes: todo a la vista, como antes', () => {
    const all = paymentMethodsOf(null);
    expect((['qr', 'wallet', 'pos'] as const).every((m) => cobroModeAllowed(m, all))).toBe(true);
    expect(visibleTabsFor(['home', 'wallet', 'pos'], all)).toEqual(['home', 'wallet', 'pos']);
  });

  it('tarjeta apagada: ni QR ni recarga (se paga con tarjeta); el datáfono sigue', () => {
    const m = paymentMethodsOf({ card: false });
    expect(cobroModeAllowed('qr', m)).toBe(false);
    expect(cobroModeAllowed('wallet', m)).toBe(false);
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
