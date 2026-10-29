import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYMENT_METHODS, mergePaymentMethods, paymentMethodsOf } from '@nightpay/contracts';
import { assertMethodsEnabled, newVenuePaymentMethods } from './venue-methods';

// Decisión del dueño (20-10-2026): «todo con móviles Android, sin PAX; datáfono
// apagado». El datáfono sale apagado en los locales que nunca guardaron sus
// «Formas de cobro»; quien lo guardó encendido lo conserva.
describe('el datáfono, apagado de fábrica', () => {
  it('sin nada guardado ⇒ apagado (y lo demás como siempre)', () => {
    expect(DEFAULT_PAYMENT_METHODS.pos).toBe(false);
    for (const nothing of [null, undefined, {}, 'raro', [], { pos: 'sí' }]) {
      expect(paymentMethodsOf(nothing)).toMatchObject({ pos: false, card: true, wallet: true, nfc: true, cashTopUp: true, tips: true });
    }
    // Crear un cobro por datáfono en un local así: 409 PAYMENT_METHOD_DISABLED.
    expect(() => assertMethodsEnabled(null, ['pos'])).toThrow(/no cobra ahora con datáfono/);
    expect(() => assertMethodsEnabled({ paymentMethods: {} }, ['pos'])).toThrow(/no cobra ahora con datáfono/);
  });

  it('guardado encendido ⇒ encendido (también al cambiar otra cosa después)', () => {
    expect(paymentMethodsOf({ pos: true }).pos).toBe(true);
    expect(assertMethodsEnabled({ paymentMethods: { pos: true } }, ['pos']).pos).toBe(true);
    // Guardar otra forma de cobro no se lo apaga: lo guardado se conserva.
    expect(mergePaymentMethods({ pos: true }, { tips: false })).toMatchObject({ pos: true, tips: false });
    // Y encenderlo en un local sin nada guardado lo deja guardado y encendido.
    expect(mergePaymentMethods(null, { pos: true }).pos).toBe(true);
  });

  it('los locales nuevos se guardan con el datáfono apagado y lo demás como siempre', () => {
    expect(newVenuePaymentMethods()).toEqual({ ...DEFAULT_PAYMENT_METHODS, pos: false });
    expect(paymentMethodsOf(newVenuePaymentMethods()).pos).toBe(false);
  });
});
