import { expect, it } from 'vitest';
import { customerCardDestination } from './customer-card';
it('un cliente abre su consulta NFC; el personal conserva el cobro de la ficha', () => {
  const token = 'cardToken0123456789';
  expect(customerCardDestination(token, false, 'https://api.paytomaxx.com/')).toBe(`https://api.paytomaxx.com/w/card/${token}`);
  expect(customerCardDestination(token, true, 'https://api.paytomaxx.com')).toBeNull();
  expect(customerCardDestination(null, false, 'https://api.paytomaxx.com')).toBeNull();
  expect(customerCardDestination('javascript:evil', false, 'https://api.paytomaxx.com')).toBeNull();
});
