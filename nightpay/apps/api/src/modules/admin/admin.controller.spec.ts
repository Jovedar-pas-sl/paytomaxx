import { describe, it, expect } from 'vitest';
import { quarterRange } from './admin.controller';

describe('quarterRange', () => {
  it('Q1-2026 → 1-ene-2026 a 1-abr-2026', () => {
    const r = quarterRange('Q1-2026');
    expect(r.label).toBe('Q1-2026');
    expect(r.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('Q2-2026 → 1-abr a 1-jul', () => {
    const r = quarterRange('Q2-2026');
    expect(r.from.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('Q3-2026 → 1-jul a 1-oct', () => {
    const r = quarterRange('Q3-2026');
    expect(r.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('Q4-2025 cruza año → 1-oct-2025 a 1-ene-2026', () => {
    const r = quarterRange('Q4-2025');
    expect(r.from.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('undefined → quarter actual basado en fecha UTC del sistema', () => {
    const r = quarterRange(undefined);
    expect(r.label).toMatch(/^Q[1-4]-\d{4}$/);
    // El intervalo debe ser de 3 meses exactos
    const diffMonths =
      (r.to.getUTCFullYear() - r.from.getUTCFullYear()) * 12 +
      (r.to.getUTCMonth() - r.from.getUTCMonth());
    expect(diffMonths).toBe(3);
  });

  it('formato inválido lanza Error', () => {
    expect(() => quarterRange('Q5-2026')).toThrow();
    expect(() => quarterRange('Q1-26')).toThrow();
    expect(() => quarterRange('2026-Q1')).toThrow();
    // Nota: '' es falsy → quarterRange lo trata como "current quarter", no throw.
    // El validator zod regex bloquea '' antes de llegar a la función en producción.
  });
});
