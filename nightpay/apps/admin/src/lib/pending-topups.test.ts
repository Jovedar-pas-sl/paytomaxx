import { describe, expect, it } from 'vitest';
import { assignedText, normalizeSaldoCode, saldoCodeProblem } from './pending-topups';

describe('asignar una recarga pendiente con el código del saldo', () => {
  it('el código como se teclee: mayúsculas y con su guion', () => {
    expect(normalizeSaldoCode('k7q 4m2')).toBe('K7Q-4M2');
    expect(normalizeSaldoCode('K7Q-4M2')).toBe('K7Q-4M2');
    expect(saldoCodeProblem('k7q4m2')).toBeNull();
    expect(saldoCodeProblem('K7Q')).toMatch(/6 letras/);
    expect(saldoCodeProblem('K7Q-4M2-X')).toMatch(/6 letras/);
  });

  it('lo que se dice al asignarla', () => {
    expect(assignedText({ walletId: 'w', codeHint: 'K7Q-•••', amountCents: 5_000, balanceCents: 6_200 })).toMatch(
      /^50,00\s€ sumados al saldo K7Q-•••: ahora tiene 62,00\s€\.$/,
    );
  });
});
