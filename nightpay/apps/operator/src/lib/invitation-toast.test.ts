import { describe, expect, it } from 'vitest';
import { invitationArrived } from './invitation-toast';

describe('«Te han invitado · +10 €»', () => {
  it('avisa con lo que se lleva de la invitación nueva', () => {
    expect(invitationArrived({ count: 5, shareCents: 5000 }, { count: 6, shareCents: 6000 })).toBe(1000);
    expect(invitationArrived({ count: 5, shareCents: 5000 }, { count: 7, shareCents: 7500 })).toBe(2500);
  });

  it('la primera lectura, sin cambios o un API antiguo: nada', () => {
    expect(invitationArrived(null, { count: 6, shareCents: 6000 })).toBeNull();
    expect(invitationArrived({ count: 6, shareCents: 6000 }, { count: 6, shareCents: 6000 })).toBeNull();
    expect(invitationArrived({ count: 6, shareCents: 6000 }, undefined)).toBeNull();
    // Una devolución que baja su parte: no es una invitación nueva.
    expect(invitationArrived({ count: 6, shareCents: 6000 }, { count: 7, shareCents: 6000 })).toBeNull();
  });
});
