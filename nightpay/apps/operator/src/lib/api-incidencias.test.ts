import { describe, expect, it } from 'vitest';
import { MIN_NOTE_LENGTH, incidentWhen, noteReady } from './api-incidencias';

describe('Recepción → Incidencias', () => {
  it('se cierra con una nota de al menos 3 letras (como en el panel)', () => {
    expect(MIN_NOTE_LENGTH).toBe(3);
    expect(noteReady('')).toBe(false);
    expect(noteReady('  ok  ')).toBe(false);
    expect(noteReady('era suyo')).toBe(true);
  });

  it('cuándo fue, como en toda la app (formatRelative, hora de Madrid)', () => {
    const now = new Date('2026-11-17T00:10:00Z');
    expect(incidentWhen('2026-11-17T00:09:40Z', now)).toBe('ahora');
    expect(incidentWhen('2026-11-16T23:58:00Z', now)).toBe('hace 12 min');
    expect(incidentWhen('2026-11-16T22:40:00Z', now)).toBe('hace 1 h');
    expect(incidentWhen('2026-11-15T22:40:00Z', now)).toBe('ayer, 23:40');
  });
});
