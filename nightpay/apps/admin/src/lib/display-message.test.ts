import { describe, expect, it } from 'vitest';
import { displayMessagePlan, lineLength } from './display-message';

/** Ajustes → Carta → «Pantalla del cliente»: lo que se guarda es lo que enseña la vista previa. */
describe('mensaje de la pantalla del cliente en el panel', () => {
  it('lo escrito, sin espacios de sobra; vacío = sin mensaje; la segunda sola sube', () => {
    expect(displayMessagePlan({ line1: ' 2x1 en copas ', line2: '' })).toEqual({ ok: true, message: { line1: '2x1 en copas', line2: null } });
    expect(displayMessagePlan({ line1: '', line2: '' })).toEqual({ ok: true, message: { line1: null, line2: null } });
    expect(displayMessagePlan({ line1: '', line2: 'Fiesta blanca' })).toEqual({ ok: true, message: { line1: 'Fiesta blanca', line2: null } });
  });

  it('más de 120 letras en una línea: no se guarda y dice por qué', () => {
    expect(displayMessagePlan({ line1: 'a'.repeat(121), line2: '' })).toEqual({ ok: false, problem: 'Como mucho 120 letras por línea' });
    expect(displayMessagePlan({ line1: 'ok', line2: 'b'.repeat(121) })).toMatchObject({ ok: false });
  });

  it('el contador cuenta como se guarda (los espacios de sobra no)', () => {
    expect(lineLength('  2x1   en copas \n')).toBe(12);
    expect(lineLength('')).toBe(0);
  });
});
