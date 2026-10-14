import { describe, it, expect } from 'vitest';
import { expectedChicaReversal } from './refund-share';

// Servicio de 100 € con 10 € de propina: la chica se lleva 90 € + 10 €.
const base = { commissionCents: 9000, tipCents: 1000, chargedCents: 11_000 };

describe('lo que se le quita a la chica al devolver un cobro', () => {
  it('devolución total → comisión y propina', () => {
    expect(expectedChicaReversal({ ...base, refundedCents: 11_000 })).toBe(10_000);
  });

  it('devolución de la mitad → la mitad de cada una', () => {
    expect(expectedChicaReversal({ ...base, refundedCents: 5500 })).toBe(5000);
  });

  it('en varias devoluciones suma exactamente su parte (sin céntimos sueltos)', () => {
    const first = expectedChicaReversal({ ...base, refundedCents: 3333 });
    const total = expectedChicaReversal({ ...base, refundedCents: 11_000 });
    expect(total).toBe(10_000);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(total);
  });

  it('cobro sin propina → como antes, la comisión en proporción', () => {
    expect(expectedChicaReversal({ commissionCents: 9000, tipCents: 0, chargedCents: 10_000, refundedCents: 4000 })).toBe(
      3600,
    );
  });

  it('la propina era para el local → solo la comisión', () => {
    expect(expectedChicaReversal({ commissionCents: 9000, tipCents: 0, chargedCents: 11_000, refundedCents: 11_000 })).toBe(
      9000,
    );
  });

  it('nunca más de su parte ni con importes raros', () => {
    expect(expectedChicaReversal({ ...base, refundedCents: 99_999 })).toBe(10_000);
    expect(expectedChicaReversal({ ...base, refundedCents: -5 })).toBe(0);
    expect(expectedChicaReversal({ ...base, chargedCents: 0, refundedCents: 100 })).toBe(0);
  });
});
