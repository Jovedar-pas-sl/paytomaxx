import { describe, expect, it } from 'vitest';
import { operatorErrorMessage } from './api';
import { codeErrorText } from './api-codes';

describe('errores con código del API', () => {
  it('tope legal de efectivo: la frase y lo que dice el API de cuánto cabe', () => {
    expect(codeErrorText('CASH_LIMIT', 'En efectivo, este saldo ya lleva 950,00 € en 24 h: como mucho 49,99 € más.')).toBe(
      'Tope legal de efectivo (1.000 € en 24 h) alcanzado para este saldo. En efectivo, este saldo ya lleva 950,00 € en 24 h: como mucho 49,99 € más.',
    );
    expect(codeErrorText('CASH_LIMIT')).toBe('Tope legal de efectivo (1.000 € en 24 h) alcanzado para este saldo.');
  });

  it('saldo bloqueado al buscarlo por su código', () => {
    expect(codeErrorText('WALLET_BLOCKED', 'Este saldo está bloqueado: …')).toBe('Saldo bloqueado. Avisa al encargado.');
    expect(operatorErrorMessage(409, 'Este saldo está bloqueado: …', 'Código de saldo', 'WALLET_BLOCKED')).toBe(
      'Saldo bloqueado. Avisa al encargado.',
    );
  });

  it('otro código o ninguno: lo de siempre', () => {
    expect(codeErrorText('OTRO', 'x')).toBeNull();
    expect(codeErrorText(null)).toBeNull();
    expect(operatorErrorMessage(409, 'Ya cobrado', 'Cobro', null)).toBe('Ya cobrado');
  });
});
