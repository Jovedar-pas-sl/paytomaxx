import { describe, expect, it } from 'vitest';
import { payoutDoneText } from './wallet-payout';

describe('lo que se dice al devolver el saldo', () => {
  it('en efectivo solo una parte: lo que se da y lo que queda para la tarjeta', () => {
    expect(payoutDoneText({ refundedCents: 4_000, method: 'CASH', remainingCents: 6_000 })).toMatch(
      /^Se devuelven 40,00\s€ en efectivo; quedan 60,00\s€ para devolver a la tarjeta\.$/,
    );
  });

  it('todo: saldo cerrado', () => {
    expect(payoutDoneText({ refundedCents: 4_000, method: 'CASH' })).toMatch(/^Apuntado: 40,00\s€ devueltos en efectivo\. Saldo cerrado\.$/);
    expect(payoutDoneText({ refundedCents: 4_000, method: 'CARD', remainingCents: 0 })).toMatch(/devueltos a la tarjeta\. Saldo cerrado\.$/);
  });
});
