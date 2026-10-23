import { describe, expect, it } from 'vitest';
import { FALLBACK_SECTIONS, chargeSectionLabel, initialSection, offeredSections, receptionChip, sectionColor } from './sections';

describe('secciones en «Otro importe»', () => {
  it('se ofrecen las encendidas (nunca ninguna)', () => {
    const off = FALLBACK_SECTIONS.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, enabled: false } : s));
    expect(offeredSections(off).map((s) => s.code)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_ENTRY']);
    expect(offeredSections(FALLBACK_SECTIONS.map((s) => ({ ...s, enabled: false })))).toEqual(FALLBACK_SECTIONS);
  });

  it('solo las que su puesto puede cobrar (la chica, Servicios)', () => {
    expect(offeredSections(FALLBACK_SECTIONS, ['CHICA_SERVICE']).map((s) => s.code)).toEqual(['CHICA_SERVICE']);
    expect(offeredSections(FALLBACK_SECTIONS, ['VENUE_BAR', 'VENUE_FOOD', 'VENUE_ENTRY']).map((s) => s.code)).toEqual([
      'VENUE_BAR',
      'VENUE_FOOD',
      'VENUE_ENTRY',
    ]);
  });

  it('marcada de entrada: la del puesto si se ofrece; si no, la primera', () => {
    expect(initialSection(FALLBACK_SECTIONS, 'VENUE_ENTRY')).toBe('VENUE_ENTRY');
    expect(initialSection(FALLBACK_SECTIONS.filter((s) => s.code !== 'VENUE_ENTRY'), 'VENUE_ENTRY')).toBe('CHICA_SERVICE');
    expect(initialSection(FALLBACK_SECTIONS, null)).toBe('CHICA_SERVICE');
  });

  it('el PAGADO dice de qué sección es (o «Varias»)', () => {
    expect(chargeSectionLabel([{ category: 'VENUE_BAR' }], FALLBACK_SECTIONS)).toBe('Copas');
    expect(chargeSectionLabel([{ category: 'CHICA_SERVICE' }, { category: 'VENUE_ROOM' }], FALLBACK_SECTIONS)).toBe('Varias');
    expect(chargeSectionLabel([], FALLBACK_SECTIONS)).toBeNull();
    expect(chargeSectionLabel(undefined, FALLBACK_SECTIONS)).toBeNull();
  });

  it('cada servicio de la carta con el color de su sección (los antiguos, el de «Otros»)', () => {
    expect(sectionColor(FALLBACK_SECTIONS, 'VENUE_ROOM')).toBe('#c4b0f5');
    expect(sectionColor(FALLBACK_SECTIONS, 'EXTRA')).toBe('#7c8893');
  });
});

describe('el chip de Recepción', () => {
  it('dice el nombre que el local dio a sus entradas (o el de fábrica)', () => {
    expect(receptionChip(FALLBACK_SECTIONS)).toEqual({ section: 'VENUE_ENTRY', label: 'Entradas' });
    const own = FALLBACK_SECTIONS.map((x) => (x.code === 'VENUE_ENTRY' ? { ...x, label: 'Puerta' } : x));
    expect(receptionChip(own).label).toBe('Puerta');
  });
});
