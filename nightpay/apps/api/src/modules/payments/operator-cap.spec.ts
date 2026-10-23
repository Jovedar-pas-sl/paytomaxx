import { describe, it, expect } from 'vitest';
import { operatorCapProblem } from './operator-cap';

const base = {
  creatorRole: 'OPERATOR',
  isWalletTopUp: false,
  fromMenu: false,
  amountCents: 15_000,
  tipCents: 0,
  capCents: 20_000,
};

describe('operatorCapProblem — tope del local para la chica', () => {
  it('dentro del tope → sin problema', () => {
    expect(operatorCapProblem(base)).toBeNull();
  });

  it('la propina cuenta: importe + propina por encima del tope → 400', () => {
    const msg = operatorCapProblem({ ...base, tipCents: 6_000 });
    expect(msg).toContain('Importe 210.00 € (con propina) supera el límite del local (200.00 €)');
  });

  it('sin propina el mensaje es el de siempre', () => {
    expect(operatorCapProblem({ ...base, amountCents: 25_000 })).toMatch(/^Importe 250\.00 € supera el límite del local \(200\.00 €\)\./);
  });

  it('dice qué hacer con las palabras de la app (saldo, dueño, límite), sin «wallet top-up» ni «cap»', () => {
    expect(operatorCapProblem({ ...base, amountCents: 25_000 })).toBe(
      'Importe 250.00 € supera el límite del local (200.00 €). Las recargas de saldo no tienen límite; para cobros puntuales pídele al dueño que lo suba en Ajustes.',
    );
  });

  it('servicio de la carta: el importe lo pone el local, cuenta solo la propina', () => {
    expect(operatorCapProblem({ ...base, fromMenu: true, amountCents: 30_000, tipCents: 5_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, fromMenu: true, amountCents: 30_000, tipCents: 25_000 })).not.toBeNull();
  });

  it('recargas de saldo y personal del local: sin tope', () => {
    expect(operatorCapProblem({ ...base, isWalletTopUp: true, amountCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: 'MANAGER', amountCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: 'WAITER', amountCents: 90_000, tipCents: 9_000 })).toBeNull();
  });
});
