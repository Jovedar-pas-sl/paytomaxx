import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { BRAND_FONT_FACE, MANROPE_PATH, MANROPE_URL, MANROPE_WOFF2, SANS_PATH, SANS_URL, SANS_WOFF2 } from './brand-font';
import { BrandFontController } from './brand-font.controller';
import { CLUB_BASE_CSS } from './club-ui';

const APPS_FONTS = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'ui', 'fonts');

describe('las letras de la marca en las páginas del cliente (Grafito)', () => {
  it.each([
    ['manrope-var.woff2', MANROPE_WOFF2],
    ['instrument-sans.woff2', SANS_WOFF2],
  ])('%s es el mismo woff2 que usan las apps (no se separan)', (file, bytes) => {
    expect(bytes.equals(readFileSync(join(APPS_FONTS, file)))).toBe(true);
    // Un woff2 de verdad (firma «wOF2») y pequeño (≈30-34 KB).
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(bytes.length).toBeLessThan(40_000);
  });

  it('la URL lleva la versión del fichero: si cambia la fuente, cambia la URL', () => {
    for (const [path, url, bytes] of [
      [MANROPE_PATH, MANROPE_URL, MANROPE_WOFF2],
      [SANS_PATH, SANS_URL, SANS_WOFF2],
    ] as const) {
      const v = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
      expect(url).toBe(`${path}?v=${v}`);
      expect(BRAND_FONT_FACE).toContain(`url('${url}') format('woff2')`);
    }
    expect(BRAND_FONT_FACE).toContain("font-family:'OxioSans'");
    expect(BRAND_FONT_FACE).toContain("font-family:'OxioManrope'");
    expect(BRAND_FONT_FACE.match(/font-display:swap/g)).toHaveLength(2);
    // Los rangos de cada fichero: texto 400-700 y cifras 600-800 (las páginas no piden más de 700).
    expect(BRAND_FONT_FACE).toContain('font-weight:400 700');
    expect(BRAND_FONT_FACE).toContain('font-weight:600 800');
  });

  it('el texto en Instrument Sans y las cifras en Manrope; los títulos, en la del texto', () => {
    expect(CLUB_BASE_CSS.startsWith(BRAND_FONT_FACE)).toBe(true);
    expect(CLUB_BASE_CSS).toContain("--sans:'OxioSans',var(--sys)");
    expect(CLUB_BASE_CSS).toContain("--num:'OxioManrope',var(--sys)");
    expect(CLUB_BASE_CSS).toMatch(/h1,h2\{[^}]*font-family:var\(--sans\)/);
    expect(CLUB_BASE_CSS).toMatch(/\.num\{font-family:var\(--num\)/);
    expect(CLUB_BASE_CSS).toMatch(/body\{[^}]*font:400 16px\/1\.5 var\(--sans\)/);
  });

  it.each([
    ['manrope', MANROPE_PATH, MANROPE_WOFF2],
    ['sans', SANS_PATH, SANS_WOFF2],
  ] as const)('%s: se sirve desde el propio API, fuera de /v1, como fuente y en caché un año', (method, path, bytes) => {
    expect(UNPREFIXED_ROUTES).toContainEqual(expect.objectContaining({ path: path.slice(1) }));
    const headers: Record<string, string> = {};
    let sent: unknown = null;
    const reply = {
      status: vi.fn(() => reply),
      header: vi.fn((k: string, v: string) => {
        headers[k] = v;
        return reply;
      }),
      send: vi.fn((b: unknown) => {
        sent = b;
        return reply;
      }),
    };
    new BrandFontController()[method](reply as unknown as FastifyReply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(headers['Content-Type']).toBe('font/woff2');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(sent).toBe(bytes);
  });
});
