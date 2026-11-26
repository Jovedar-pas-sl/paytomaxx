import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkServed, invitationArrived, servedBaseline } from './invitation-toast';

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

describe('«Servicio cobrado · +54 €» al leer su noche (lo visto, guardado en el móvil)', () => {
  const FROM = '2026-11-25T21:00:00.000Z';
  const KEY = 'np_served_seen:u1';
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const night = (count: number, shareCents: number) => ({ from: FROM, served: { count, shareCents } });

  it('con lo guardado de la misma noche (la app estuvo cerrada): avisa y guarda lo nuevo', () => {
    store.set(KEY, JSON.stringify({ from: FROM, count: 0, shareCents: 0 }));
    const r = checkServed('u1', null, night(1, 5400));
    expect(r.cents).toBe(5400);
    expect(r.seen).toEqual({ from: FROM, count: 1, shareCents: 5400 });
    expect(JSON.parse(store.get(KEY)!)).toEqual({ from: FROM, count: 1, shareCents: 5400 });
    // La siguiente lectura, sin nada nuevo: no avisa otra vez.
    expect(checkServed('u1', r.seen, night(1, 5400)).cents).toBeNull();
  });

  it('lo guardado es de otra noche o no hay nada: no avisa (primera lectura), pero guarda', () => {
    store.set(KEY, JSON.stringify({ from: '2026-11-24T21:00:00.000Z', count: 3, shareCents: 9000 }));
    expect(checkServed('u1', null, night(1, 5400)).cents).toBeNull();
    expect(JSON.parse(store.get(KEY)!)).toEqual({ from: FROM, count: 1, shareCents: 5400 });
  });

  it('InvitationToast lo mira en cada lectura de su noche y avisa «Servicio cobrado»', () => {
    const toast = readFileSync(new URL('../components/InvitationToast.tsx', import.meta.url), 'utf8');
    expect(toast).toContain('checkServed(userId, lastServed.current, night)');
    expect(toast).toContain("{ what: 'Servicio cobrado', cents: served }");
  });

  it('un API de antes (sin «served»): ni avisa ni guarda', () => {
    const before = { from: FROM, count: 1, shareCents: 5400 };
    expect(checkServed('u1', before, { from: FROM })).toEqual({ cents: null, seen: before });
    expect(store.size).toBe(0);
  });
});
