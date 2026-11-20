import { describe, it, expect, vi } from 'vitest';
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

  it('recargas de saldo, el dueño y los cobros sin persona (reservados, el cliente): sin tope', () => {
    expect(operatorCapProblem({ ...base, isWalletTopUp: true, amountCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: 'OWNER', amountCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: undefined, amountCents: 90_000 })).toBeNull();
  });

  it('camarero y encargado (decisión del dueño, 19-11-2026): el mismo tope del local en «Otro importe»', () => {
    for (const creatorRole of ['WAITER', 'MANAGER']) {
      expect(operatorCapProblem({ ...base, creatorRole, amountCents: 25_000 }), creatorRole).toMatch(/^Importe 250\.00 € supera el límite del local/);
      expect(operatorCapProblem({ ...base, creatorRole, amountCents: 20_000 }), creatorRole).toBeNull();
      // La carta no cuenta: el precio lo pone el local.
      expect(operatorCapProblem({ ...base, creatorRole, fromMenu: true, amountCents: 90_000 }), creatorRole).toBeNull();
    }
  });

  it('OxioParty (EDITION=party): solo el personal, como en main; su panel no tiene «Reglas del local» para cambiar el tope', () => {
    vi.stubEnv('EDITION', 'party');
    try {
      for (const creatorRole of ['WAITER', 'MANAGER']) {
        expect(operatorCapProblem({ ...base, creatorRole, amountCents: 90_000 }), creatorRole).toBeNull();
      }
      expect(operatorCapProblem({ ...base, amountCents: 25_000 })).toMatch(/^Importe 250\.00 € supera el límite del local/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
