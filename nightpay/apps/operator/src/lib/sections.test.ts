import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, OLD_DEFAULT_SECTION_COLORS, SECTION_CODES, mergeSections, sectionMeta, sectionsOf, type VenueSection } from '@nightpay/contracts';
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
    expect(sectionColor(FALLBACK_SECTIONS, 'VENUE_ROOM')).toBe('#bbb8fe');
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

describe('colores guardados de fábrica antiguos (colores con más vida)', () => {
  // Todas las generaciones anteriores: las de antes de «colores con más vida» y,
  // desde «Color y relieve» (25-nov-2026), también los vivos de Grafito.
  const OLD = {
    CHICA_SERVICE: ['#d24fd8', '#df73e4', '#e447f0'],
    VENUE_BAR: ['#3fe0c0', '#00e0ae'],
    VENUE_ROOM: ['#c4b0f5', '#a98bff'],
    VENUE_FOOD: ['#f2b49b', '#ff8a3d'],
    VENUE_ENTRY: ['#8fc3f2', '#3d9bff'],
  } as const;

  it('los de fábrica de hoy son los de «Color y relieve» y ninguno está en la lista de antiguos', () => {
    expect(Object.fromEntries(SECTION_CODES.map((code) => [code, DEFAULT_SECTIONS[code].color]))).toEqual({
      CHICA_SERVICE: '#ff77a2',
      VENUE_BAR: '#46efd4',
      VENUE_ROOM: '#bbb8fe',
      VENUE_FOOD: '#fd622d',
      VENUE_ENTRY: '#4d94fb',
    });
    for (const code of SECTION_CODES) {
      expect(OLD_DEFAULT_SECTION_COLORS[code], code).toEqual(OLD[code]);
      expect(OLD_DEFAULT_SECTION_COLORS[code], code).not.toContain(DEFAULT_SECTIONS[code].color);
    }
  });

  it('un color guardado igual a uno de fábrica antiguo cuenta como el de fábrica: sale el nuevo', () => {
    for (const code of SECTION_CODES) {
      for (const old of OLD[code]) {
        const got = sectionsOf({ [code]: { color: old.toUpperCase(), label: 'Mi nombre' } }).find((s) => s.code === code)!;
        expect(got.color, `${code} ${old}`).toBe(DEFAULT_SECTIONS[code].color);
        expect(got.label).toBe('Mi nombre');
      }
    }
  });

  it('el color que el dueño eligió a mano se respeta', () => {
    const got = sectionsOf({ VENUE_BAR: { color: '#123456' }, VENUE_FOOD: { color: '#3FE0C0' } });
    expect(got.find((s) => s.code === 'VENUE_BAR')!.color).toBe('#123456');
    // Un color de fábrica de OTRA sección, puesto a mano aquí, también es una elección suya.
    expect(got.find((s) => s.code === 'VENUE_FOOD')!.color).toBe('#3fe0c0');
  });

  it('sectionMeta traduce el antiguo y deja el del dueño', () => {
    const stored: VenueSection[] = SECTION_CODES.map((code) => ({
      code,
      enabled: true,
      label: DEFAULT_SECTIONS[code].label,
      color: code === 'VENUE_ROOM' ? '#abcdef' : OLD[code][0],
    }));
    expect(sectionMeta(stored, 'VENUE_BAR').color).toBe('#46efd4');
    expect(sectionMeta(stored, 'CHICA_SERVICE').color).toBe('#ff77a2');
    expect(sectionMeta(stored, 'VENUE_ROOM').color).toBe('#abcdef');
  });

  it('un local con los vivos de Grafito guardados (los de fábrica hasta el 25-nov) no se queda con ellos', () => {
    const grafito = { CHICA_SERVICE: '#e447f0', VENUE_BAR: '#00e0ae', VENUE_ROOM: '#a98bff', VENUE_FOOD: '#ff8a3d', VENUE_ENTRY: '#3d9bff' } as const;
    const raw = Object.fromEntries(SECTION_CODES.map((code) => [code, { color: grafito[code], label: `La mía ${code}`, enabled: true }]));
    for (const s of sectionsOf(raw)) {
      expect(s.color, s.code).toBe(DEFAULT_SECTIONS[s.code].color);
      // El nombre que puso el local se queda.
      expect(s.label, s.code).toBe(`La mía ${s.code}`.slice(0, 24));
    }
    // Y lo que se enseña a partir de la lista ya leída (cobros, informes), igual.
    const stored: VenueSection[] = SECTION_CODES.map((code) => ({ code, enabled: true, label: 'x', color: grafito[code] }));
    for (const code of SECTION_CODES) expect(sectionMeta(stored, code).color, code).toBe(DEFAULT_SECTIONS[code].color);
  });

  it('guardar un cambio de nombre no fija el color antiguo: mergeSections lo deja en el nuevo', () => {
    const merged = mergeSections({ VENUE_BAR: { color: '#3fe0c0' } }, { sections: { VENUE_BAR: { label: 'Barra' } } });
    expect(merged?.VENUE_BAR).toMatchObject({ label: 'Barra', color: '#46efd4' });
    // Lo mismo con el vivo de Grafito guardado.
    const again = mergeSections({ VENUE_BAR: { color: '#00E0AE' } }, { sections: { VENUE_BAR: { label: 'Barra' } } });
    expect(again?.VENUE_BAR).toMatchObject({ label: 'Barra', color: '#46efd4' });
  });
});
