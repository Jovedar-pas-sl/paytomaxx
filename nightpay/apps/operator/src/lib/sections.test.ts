import { describe, expect, it } from 'vitest';
import { FALLBACK_SECTIONS, chargeSectionLabel, initialSection, offeredSections, sectionColor } from './sections';

describe('secciones en «Otro importe»', () => {
  it('se ofrecen las encendidas (nunca ninguna)', () => {
    const off = FALLBACK_SECTIONS.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, enabled: false } : s));
    expect(offeredSections(off).map((s) => s.code)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_ENTRY']);
    expect(offeredSections(FALLBACK_SECTIONS.map((s) => ({ ...s, enabled: false })))).toEqual(FALLBACK_SECTIONS);
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
    expect(sectionColor(FALLBACK_SECTIONS, 'VENUE_ROOM')).toBe('#b98cff');
    expect(sectionColor(FALLBACK_SECTIONS, 'EXTRA')).toBe('#a3a39b');
  });
});
