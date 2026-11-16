import { describe, expect, it } from 'vitest';
import { MIN_NOTE_LENGTH, incidentWhen, noteReady } from './api-incidencias';

describe('Recepción → Incidencias', () => {
  it('se cierra con una nota de al menos 3 letras (como en el panel)', () => {
    expect(MIN_NOTE_LENGTH).toBe(3);
    expect(noteReady('')).toBe(false);
    expect(noteReady('  ok  ')).toBe(false);
    expect(noteReady('era suyo')).toBe(true);
  });

  it('la hora en Madrid', () => {
    expect(incidentWhen('2026-11-16T22:40:00Z')).toBe('16/11 · 23:40');
  });
});
