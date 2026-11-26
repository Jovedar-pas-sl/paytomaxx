import { describe, it, expect, vi } from 'vitest';
import { resolveChargeLines } from './charge-lines';
import { operatorCapProblem } from './operator-cap';

const base = {
  creatorRole: 'OPERATOR',
  isWalletTopUp: false,
  typedCents: 15_000,
  tipCents: 0,
  capCents: 20_000,
};

describe('operatorCapProblem — tope del local para la chica', () => {
  it('dentro del tope → sin problema', () => {
    expect(operatorCapProblem(base)).toBeNull();
  });

  it('la propina cuenta: importe + propina por encima del tope → 400', () => {
    const msg = operatorCapProblem({ ...base, tipCents: 6_000 });
    expect(msg).toContain('Importe 210,00\u00a0€ (con propina) supera el límite del local (200,00\u00a0€)');
  });

  it('sin propina el mensaje es el de siempre', () => {
    expect(operatorCapProblem({ ...base, typedCents: 25_000 })).toMatch(/^Importe 250,00\u00a0€ supera el límite del local \(200,00\u00a0€\)\./);
  });

  it('dice qué hacer con las palabras de la app (saldo, dueño, límite), sin «wallet top-up» ni «cap»', () => {
    expect(operatorCapProblem({ ...base, typedCents: 25_000 })).toBe(
      'Importe 250,00\u00a0€ supera el límite del local (200,00\u00a0€). Las recargas de saldo no tienen límite; para cobros puntuales pídele al dueño que lo suba en Ajustes.',
    );
  });

  it('servicio de la carta: el importe lo pone el local, cuenta solo la propina', () => {
    expect(operatorCapProblem({ ...base, typedCents: 0, tipCents: 5_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, typedCents: 0, tipCents: 25_000 })).not.toBeNull();
  });

  it('cuenta mixta (carta + «Otro importe»): cuenta solo lo tecleado; lo tecleado por encima del tope sigue parado', () => {
    // 2 botellas de la carta (280 €) y lo tecleado, con el tope de fábrica (200 €), como lo pide payments.service.
    const botella = { id: 'botella', name: 'Botella', priceCents: 14_000, durationMin: null, category: 'VENUE_BAR', active: true, components: null };
    const problem = (creatorRole: string, typedAmountCents: number) => {
      const r = resolveChargeLines({
        lines: [{ serviceItemId: botella.id, qty: 2 }, { category: 'VENUE_BAR', amountCents: typedAmountCents }],
        role: creatorRole,
        items: new Map([[botella.id, botella]]),
      });
      if (!r.ok) throw new Error(r.reason);
      return operatorCapProblem({ ...base, creatorRole, typedCents: r.charge.typedCents });
    };
    for (const creatorRole of ['WAITER', 'MANAGER', 'OPERATOR']) {
      expect(problem(creatorRole, 600), creatorRole).toBeNull();
      expect(problem(creatorRole, 25_000), creatorRole).toMatch(/^Importe 250,00\u00a0€ supera el límite del local \(200,00\u00a0€\)\./);
    }
  });

  it('recargas de saldo, el dueño y los cobros sin persona (reservados, el cliente): sin tope', () => {
    expect(operatorCapProblem({ ...base, isWalletTopUp: true, typedCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: 'OWNER', typedCents: 90_000 })).toBeNull();
    expect(operatorCapProblem({ ...base, creatorRole: undefined, typedCents: 90_000 })).toBeNull();
  });

  it('camarero y encargado (decisión del dueño, 19-11-2026): el mismo tope del local en «Otro importe»', () => {
    for (const creatorRole of ['WAITER', 'MANAGER']) {
      expect(operatorCapProblem({ ...base, creatorRole, typedCents: 25_000 }), creatorRole).toMatch(/^Importe 250,00\u00a0€ supera el límite del local/);
      expect(operatorCapProblem({ ...base, creatorRole, typedCents: 20_000 }), creatorRole).toBeNull();
      // La carta no cuenta: el precio lo pone el local.
      expect(operatorCapProblem({ ...base, creatorRole, typedCents: 0 }), creatorRole).toBeNull();
    }
  });

  it('OxioParty (EDITION=party): solo el personal, como en main; su panel no tiene «Reglas del local» para cambiar el tope', () => {
    vi.stubEnv('EDITION', 'party');
    try {
      for (const creatorRole of ['WAITER', 'MANAGER']) {
        expect(operatorCapProblem({ ...base, creatorRole, typedCents: 90_000 }), creatorRole).toBeNull();
      }
      expect(operatorCapProblem({ ...base, typedCents: 25_000 })).toMatch(/^Importe 250,00\u00a0€ supera el límite del local/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
