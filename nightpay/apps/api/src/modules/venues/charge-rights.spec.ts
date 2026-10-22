import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type HttpException } from '@nestjs/common';
import {
  DEFAULT_POST_RULES,
  DEFAULT_SECTIONS,
  SECTION_CODES,
  allowedSections,
  chargeRightsOf,
  initialOfferedSection,
  mergePostRules,
  postRulesOf,
  sectionNotAllowedMessage,
  staffPermissionsOf,
} from '@nightpay/contracts';
import { assertCanHandleCash, assertSectionsAllowed, chargeRightsFor } from './charge-rights';

const FALLBACK_SECTIONS_FOR_TESTS = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));

const label = (code: string) =>
  ({ CHICA_SERVICE: 'Servicios', VENUE_BAR: 'Copas', VENUE_ROOM: 'Habitaciones', VENUE_FOOD: 'Comida', VENUE_ENTRY: 'Entradas' })[code] ?? code;

describe('qué cobra cada puesto (de fábrica)', () => {
  const rules = postRulesOf(null);

  it('chicas: solo Servicios, con propinas, sin efectivo ni recargas (su puesto no cuenta: siempre Sala)', () => {
    expect(chargeRightsOf({ role: 'OPERATOR', post: 'RECEPCION' }, rules)).toEqual({
      post: 'SALA',
      all: false,
      sections: ['CHICA_SERVICE'],
      tips: true,
      cash: false,
      topUps: false,
      cashPayout: false,
    });
  });

  it('camarero (Barra por defecto): Copas, Entradas y Comida; recepción: todo, efectivo y recargas, sin propinas', () => {
    expect(chargeRightsOf({ role: 'WAITER', post: null }, rules)).toMatchObject({
      post: 'BARRA',
      sections: ['VENUE_BAR', 'VENUE_FOOD', 'VENUE_ENTRY'],
      tips: true,
      cash: false,
      topUps: false,
    });
    expect(chargeRightsOf({ role: 'WAITER', post: 'RECEPCION' }, rules)).toMatchObject({
      sections: ['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY'],
      tips: false,
      cash: true,
      topUps: true,
      cashPayout: true,
    });
  });

  it('dueño y encargado: todo (su puesto, si tienen, solo marca la sección de entrada)', () => {
    expect(chargeRightsOf({ role: 'MANAGER', post: 'COCINA' }, rules)).toMatchObject({ post: 'COCINA', all: true, cash: true, topUps: true });
    expect(chargeRightsOf({ role: 'OWNER', post: null }, rules)).toMatchObject({ post: null, all: true });
  });

  it('la tabla de Ajustes manda; lo raro vuelve a lo de fábrica', () => {
    const own = postRulesOf({ BARRA: { sections: ['VENUE_BAR', 'INVENTADA'], tips: false }, COCINA: 'raro' });
    expect(own.BARRA).toEqual({ sections: ['VENUE_BAR'], tips: false, cash: false, topUps: false, cashPayout: false });
    expect(own.COCINA).toEqual(DEFAULT_POST_RULES.COCINA);
    const merged = mergePostRules(own, { posts: { BARRA: { sections: ['VENUE_ENTRY', 'VENUE_BAR'] }, RECEPCION: { tips: true } } });
    expect(merged.BARRA.sections).toEqual(['VENUE_BAR', 'VENUE_ENTRY']);
    expect(merged.BARRA.tips).toBe(false);
    expect(merged.RECEPCION.tips).toBe(true);
  });

  it('lo que ve la app y la sección marcada de entrada', () => {
    const barra = chargeRightsOf({ role: 'WAITER', post: null }, rules);
    const sections = FALLBACK_SECTIONS_FOR_TESTS.map((s) => (s.code === 'VENUE_ENTRY' ? { ...s, enabled: false } : s));
    expect(allowedSections(sections, barra).map((s) => s.code)).toEqual(['VENUE_BAR', 'VENUE_FOOD']);
    expect(initialOfferedSection(sections, barra)).toBe('VENUE_BAR');
    const cocinaSinComida = chargeRightsOf({ role: 'WAITER', post: 'COCINA' }, postRulesOf({ COCINA: { sections: ['VENUE_BAR'] } }));
    expect(initialOfferedSection(sections, cocinaSinComida)).toBe('VENUE_BAR');
  });

  it('el mensaje dice el puesto y lo que sí puede', () => {
    const barra = chargeRightsOf({ role: 'WAITER', post: null }, rules);
    expect(sectionNotAllowedMessage(barra, 'VENUE_ROOM', label)).toBe(
      'Desde tu puesto (Barra) no se cobra Habitaciones: solo Copas, Comida y Entradas.',
    );
    const chica = chargeRightsOf({ role: 'OPERATOR', post: null }, rules);
    expect(sectionNotAllowedMessage(chica, 'VENUE_BAR', label)).toBe(
      'Desde tu app solo puedes cobrar Servicios. Copas lo cobra otra persona del local.',
    );
  });
});

describe('el candado en el servidor', () => {
  it('chargeRightsFor lee el puesto de la persona y la tabla del local', async () => {
    const db = {
      user: { findFirst: vi.fn(async () => ({ post: 'RECEPCION' })) },
      venue: { findUnique: vi.fn(async () => ({ postRules: { RECEPCION: { topUps: false } }, sections: { VENUE_BAR: { label: 'Barra libre' } } })) },
    };
    const rights = await chargeRightsFor(db as never, 'venue-1', { userId: 'u-1', role: 'WAITER' });
    expect(rights).toMatchObject({ post: 'RECEPCION', topUps: false, cash: true });
    expect(rights.labelOf('VENUE_BAR')).toBe('Barra libre');
    expect(db.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'venue-1' }, select: { postRules: true, sections: true } });
  });

  it('una sección que no puede: 403 SECTION_NOT_ALLOWED con la sección', () => {
    const rights = { ...chargeRightsOf({ role: 'OPERATOR', post: null }, postRulesOf(null)), labelOf: label };
    expect(() => assertSectionsAllowed(rights, ['CHICA_SERVICE'])).not.toThrow();
    const err = (() => {
      try {
        assertSectionsAllowed(rights, ['CHICA_SERVICE', 'VENUE_ROOM']);
      } catch (e) {
        return e as HttpException;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err!.getResponse()).toMatchObject({ code: 'SECTION_NOT_ALLOWED', section: 'VENUE_ROOM' });
  });

  it('efectivo: el dueño siempre; el encargado con su permiso; el resto, recepción (y sin quitárselo a esa persona)', () => {
    const rules = postRulesOf(null);
    const none = staffPermissionsOf(null);
    const rights = (role: string, post: string | null) => chargeRightsOf({ role, post }, rules);
    expect(() => assertCanHandleCash(rights('OWNER', null), { role: 'OWNER', userId: 'o' }, none)).not.toThrow();
    expect(() => assertCanHandleCash(rights('MANAGER', null), { role: 'MANAGER', userId: 'm' }, none)).not.toThrow();
    expect(() =>
      assertCanHandleCash(rights('MANAGER', null), { role: 'MANAGER', userId: 'm' }, staffPermissionsOf({ roles: { MANAGER: { cashTopUp: false } } })),
    ).toThrow(ForbiddenException);
    expect(() => assertCanHandleCash(rights('WAITER', 'RECEPCION'), { role: 'WAITER', userId: 'w' }, none)).not.toThrow();
    expect(() => assertCanHandleCash(rights('WAITER', null), { role: 'WAITER', userId: 'w' }, none)).toThrow(/recepción/);
    expect(() => assertCanHandleCash(rights('OPERATOR', null), { role: 'OPERATOR', userId: 'c' }, none)).toThrow(/recepción/);
    expect(() =>
      assertCanHandleCash(rights('WAITER', 'RECEPCION'), { role: 'WAITER', userId: 'w' }, staffPermissionsOf({ people: { w: { cashTopUp: false } } })),
    ).toThrow(/no te deja cobrar recargas en efectivo/);
  });
});
