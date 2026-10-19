import { describe, expect, it } from 'vitest';
import { cashVoidDoneText, cashVoidProblem } from './cash-void';

describe('anular una recarga en efectivo', () => {
  it('hace falta el motivo y el código 2FA (siempre)', () => {
    expect(cashVoidProblem('', '123456')).toMatch(/por qué/);
    expect(cashVoidProblem('ok', '123456')).toMatch(/por qué/);
    expect(cashVoidProblem('mal tecleada', '')).toMatch(/6 números/);
    expect(cashVoidProblem('mal tecleada', '12345')).toMatch(/6 números/);
    expect(cashVoidProblem('mal tecleada', '123456')).toBeNull();
  });

  it('lo que sale de la caja y lo que le queda al saldo', () => {
    expect(cashVoidDoneText({ amountCents: 5_000, balanceCents: 1_000 })).toMatch(
      /^Anulada: 50,00\s€ salen de la caja\. Al saldo le quedan 10,00\s€\.$/,
    );
  });
});
