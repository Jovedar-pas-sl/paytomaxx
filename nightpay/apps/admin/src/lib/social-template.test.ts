import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  contrastRatio,
  coverCrop,
  fitVenueName,
  PHOTO_OVERLAY_ALPHA,
  SOCIAL_FORMATS,
  SOCIAL_PHRASES,
  SOCIAL_TEXT_COLOR,
  wrapText,
  worstCasePhotoBackground,
  type SocialFormat,
} from './social-template';

// Letra de ancho fijo: 0,5 × el cuerpo por carácter.
const measure = (t: string, px: number): number => t.length * px * 0.5;

describe('plantillas para redes', () => {
  it('formatos: historia 1080×1920 y publicación 1080×1080', () => {
    expect(SOCIAL_FORMATS.story).toMatchObject({ w: 1080, h: 1920 });
    expect(SOCIAL_FORMATS.post).toMatchObject({ w: 1080, h: 1080 });
    expect(computeLayout('story', SOCIAL_PHRASES[0], 'Luna', measure)).toMatchObject({ w: 1080, h: 1920 });
  });

  it('las frases son exactamente las tres aprobadas', () => {
    expect([...SOCIAL_PHRASES]).toEqual([
      'Ya puedes pagar con OxioPay',
      'Escanea, paga y sigue la noche',
      'Sin app ni registro: paga desde tu móvil',
    ]);
  });

  it('wrapText no pasa del ancho y no pierde palabras', () => {
    const lines = wrapText('uno dos tres cuatro cinco seis', 20, 100, measure);
    expect(lines.join(' ')).toBe('uno dos tres cuatro cinco seis');
    for (const l of lines) expect(measure(l, 20)).toBeLessThanOrEqual(100);
  });

  it('fitVenueName reduce la letra y, si aún no cabe, corta con «…»', () => {
    expect(fitVenueName('Luna', 50, 800, measure)).toEqual({ text: 'Luna', font: 50 });
    const long = fitVenueName('Discoteca con un nombre larguísimo '.repeat(4), 50, 400, measure);
    expect(long.font).toBeLessThan(50);
    expect(long.text.endsWith('…')).toBe(true);
    expect(measure(long.text, long.font)).toBeLessThanOrEqual(400);
  });

  for (const format of ['story', 'post'] as SocialFormat[]) {
    it(`${format}: todo cae dentro de los márgenes seguros`, () => {
      for (const phrase of SOCIAL_PHRASES) {
        const L = computeLayout(format, phrase, 'Sala Luna Llena de Valencia Centro', measure);
        const { top, bottom, side } = L.safe;
        const maxW = L.w - side * 2;
        for (const l of [...L.phrase, L.venue]) {
          const font = l === L.venue ? L.venueFont : L.phraseFont;
          expect(measure(l.text, font)).toBeLessThanOrEqual(maxW);
          expect(l.y).toBeLessThanOrEqual(L.h - bottom);
        }
        expect(L.symbol.y).toBeGreaterThanOrEqual(top);
        expect(L.wordmark.y + L.wordmark.h).toBeLessThanOrEqual(L.h - bottom);
        expect(L.wordmark.x).toBeGreaterThanOrEqual(side);
        // La última línea del nombre queda por encima del nombre escrito.
        expect(L.venue.y).toBeLessThan(L.wordmark.y);
      }
    });
  }

  it('coverCrop llena el lienzo sin deformar y centrado', () => {
    const c = coverCrop(4000, 3000, 1080, 1920);
    expect(c.w / c.h).toBeCloseTo(1080 / 1920, 5);
    expect(c.h).toBe(3000);
    expect(c.x).toBeCloseTo((4000 - c.w) / 2, 5);
  });

  it('con foto, el texto crema se lee (≥ 4,5:1) hasta sobre una foto blanca', () => {
    expect(PHOTO_OVERLAY_ALPHA).toBeGreaterThan(0);
    expect(contrastRatio(SOCIAL_TEXT_COLOR, worstCasePhotoBackground())).toBeGreaterThanOrEqual(4.5);
  });
});
