import { describe, expect, it } from 'vitest';
import { classifySessionEvent } from './session-sync';

describe('classifySessionEvent', () => {
  it('otra pestaña sale o se le caduca la sesión: fuera aquí también', () => {
    expect(classifySessionEvent({ type: 'logout', source: 'other-tab' })).toBe('signed-out');
    expect(classifySessionEvent({ type: 'expired', source: 'other-tab' })).toBe('signed-out');
  });

  it('otra pestaña entra (y esta estaba en el login)', () => {
    expect(classifySessionEvent({ type: 'signed-in', source: 'other-tab' })).toBe('signed-in');
  });

  it('otra pestaña cambia de local o entra otra persona: se recarga', () => {
    expect(classifySessionEvent({ type: 'changed', source: 'other-tab' })).toBe('venue-changed');
    // El refresco de esta pestaña devolvió a otra persona (entró en otra pestaña).
    expect(classifySessionEvent({ type: 'changed', source: 'this-tab' })).toBe('venue-changed');
  });

  it('la caducidad en esta pestaña va por SESSION_EXPIRED_EVENT, no por aquí', () => {
    expect(classifySessionEvent({ type: 'expired', source: 'this-tab' })).toBeNull();
  });
});
