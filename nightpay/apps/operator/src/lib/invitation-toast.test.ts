import { describe, expect, it } from 'vitest';
import { invitationArrived, servedBaseline } from './invitation-toast';

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

describe('«Servicio cobrado · +54 €»', () => {
  const night = { from: '2026-11-25T21:00:00.000Z' };

  it('lo visto en el móvil de la misma noche vale (también si la app estuvo cerrada); de otra noche, no', () => {
    expect(servedBaseline({ from: night.from, count: 1, shareCents: 5400 }, night)).toEqual({ count: 1, shareCents: 5400 });
    expect(servedBaseline({ from: '2026-11-24T21:00:00.000Z', count: 1, shareCents: 5400 }, night)).toBeNull();
    expect(servedBaseline(null, night)).toBeNull();
    // Lo guardado no es de fiar: si no tiene la forma, como si no hubiera nada.
    expect(servedBaseline('{', night)).toBeNull();
    expect(servedBaseline({ from: night.from, count: '1', shareCents: 5400 }, night)).toBeNull();
  });

  it('avisa con su parte de los servicios nuevos, también los cobrados con la app cerrada', () => {
    const seen = servedBaseline({ from: night.from, count: 0, shareCents: 0 }, night);
    expect(invitationArrived(seen, { count: 1, shareCents: 5400 })).toBe(5400);
    expect(invitationArrived(servedBaseline({ from: night.from, count: 1, shareCents: 5400 }, night), { count: 1, shareCents: 5400 })).toBeNull();
    // Un API anterior sin «served»: nada.
    expect(invitationArrived(seen, undefined)).toBeNull();
  });
});
