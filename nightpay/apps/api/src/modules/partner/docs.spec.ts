import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guías de la API de socios en español y en inglés (docs/partner-api/guides):
 * cada capítulo en los dos idiomas, y la española dice en su cabecera
 * (en_sha256) qué versión de la inglesa traduce: si la inglesa cambia y la
 * española no, falla.
 */

const GUIDES = join(__dirname, '../../../../../docs/partner-api/guides');
/** Con los saltos de línea de git (LF): igual en Windows que en CI. */
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const chapters = (lang: 'es' | 'en') =>
  new Map(
    readdirSync(join(GUIDES, lang))
      .filter((f) => f.endsWith('.md'))
      .map((f) => [f.slice(0, 2), f] as const),
  );
const headings = (text: string) => text.split('\n').filter((l) => /^#{1,6} /.test(l)).length;

describe('guías ES/EN', () => {
  const es = chapters('es');
  const en = chapters('en');

  it('los mismos capítulos en los dos idiomas (por su número)', () => {
    expect(es.size).toBeGreaterThan(0);
    expect([...es.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it.each([...chapters('es').entries()])('capítulo %s: en_sha256 es el de la inglesa y tienen los mismos títulos', (num, file) => {
    const esText = read(join(GUIDES, 'es', file));
    const enText = read(join(GUIDES, 'en', en.get(num)!));
    const front = /^---\nen_sha256: ([0-9a-f]{64})\n---\n/.exec(esText);
    expect(front, `${file} sin cabecera en_sha256`).not.toBeNull();
    expect(front![1]).toBe(sha256(enText));
    expect(headings(esText)).toBe(headings(enText));
  });
});
