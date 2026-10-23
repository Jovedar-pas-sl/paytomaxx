import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { BRAND_FONT_FACE, MANROPE_PATH, MANROPE_URL, MANROPE_WOFF2 } from './brand-font';
import { BrandFontController } from './brand-font.controller';
import { CLUB_BASE_CSS } from './club-ui';

const APPS_FONT = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'ui', 'fonts', 'manrope.woff2');

describe('la letra de la marca en las páginas del cliente (decisión D6)', () => {
  it('es el mismo woff2 que usan las apps (no se separan)', () => {
    const file = readFileSync(APPS_FONT);
    expect(MANROPE_WOFF2.equals(file)).toBe(true);
    // Un woff2 de verdad (firma «wOF2») y pequeño (≈17 KB).
    expect(MANROPE_WOFF2.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(MANROPE_WOFF2.length).toBeLessThan(25_000);
  });

  it('la URL lleva la versión del fichero: si cambia la fuente, cambia la URL', () => {
    const v = createHash('sha256').update(MANROPE_WOFF2).digest('hex').slice(0, 10);
    expect(MANROPE_URL).toBe(`${MANROPE_PATH}?v=${v}`);
    expect(BRAND_FONT_FACE).toContain(`url('${MANROPE_URL}') format('woff2')`);
    expect(BRAND_FONT_FACE).toContain('font-display:swap');
    expect(BRAND_FONT_FACE).toContain('font-weight:800');
  });

  it('importes y títulos en Manrope; el texto, con la letra del móvil', () => {
    expect(CLUB_BASE_CSS.startsWith(BRAND_FONT_FACE)).toBe(true);
    expect(CLUB_BASE_CSS).toContain("--num:'OxioManrope',var(--sys)");
    expect(CLUB_BASE_CSS).toMatch(/h1,h2\{[^}]*font-family:var\(--num\)/);
    expect(CLUB_BASE_CSS).toMatch(/\.num\{font-family:var\(--num\)/);
    expect(CLUB_BASE_CSS).toMatch(/body\{[^}]*font:18px\/1\.45 var\(--sys\)/);
  });

  it('se sirve desde el propio API, fuera de /v1, como fuente y en caché un año', () => {
    expect(UNPREFIXED_ROUTES).toContainEqual(expect.objectContaining({ path: MANROPE_PATH.slice(1) }));
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
    new BrandFontController().manrope(reply as unknown as FastifyReply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(headers['Content-Type']).toBe('font/woff2');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(sent).toBe(MANROPE_WOFF2);
  });
});
