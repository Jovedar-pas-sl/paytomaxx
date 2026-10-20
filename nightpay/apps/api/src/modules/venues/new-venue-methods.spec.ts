import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYMENT_METHODS, paymentMethodsOf } from '@nightpay/contracts';
import { newVenuePaymentMethods } from './venue-methods';

describe('locales nuevos: el datáfono, apagado', () => {
  it('se guarda pos: false y lo demás como siempre; los locales de antes sin nada guardado siguen con datáfono', () => {
    expect(newVenuePaymentMethods()).toEqual({ ...DEFAULT_PAYMENT_METHODS, pos: false });
    expect(paymentMethodsOf(newVenuePaymentMethods()).pos).toBe(false);
    expect(paymentMethodsOf(null).pos).toBe(true);
    expect(DEFAULT_PAYMENT_METHODS.pos).toBe(true);
  });
});
