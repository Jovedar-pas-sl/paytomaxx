import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ZodType } from 'zod';
import {
  PARTNER_ERRORS,
  PartnerConnectionSchema,
  PartnerProblemSchema,
  Statement,
  TestLiveCode,
  WalletBalance,
  WalletLoad,
  WalletLoadList,
} from '@nightpay/contracts';

/**
 * Guías de la API de socios en español y en inglés (docs/partner-api/guides):
 * cada capítulo en los dos idiomas, y la española dice en su cabecera
 * (en_sha256) qué versión de la inglesa traduce: si la inglesa cambia y la
 * española no, falla. Además (PR 8 B): los capítulos 00 a 08 en los dos
 * idiomas con los mismos bloques de código, la tabla del capítulo 5 con todos
 * los códigos de PARTNER_ERRORS, cada ejemplo JSON igual a lo que deja pasar
 * su esquema, enlaces relativos que existen y el aviso de la devolución arriba
 * del índice.
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

const ALL = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
/** Sin la cabecera en_sha256 (solo la llevan las españolas). */
const body = (lang: 'es' | 'en', file: string) => read(join(GUIDES, lang, file)).replace(/^---\nen_sha256: [0-9a-f]{64}\n---\n/, '');
/** Los bloques de código, con su lenguaje: [lenguaje, contenido]. */
const codeBlocks = (text: string) => [...text.matchAll(/^```([a-z]*)\n([\s\S]*?)^```$/gm)].map((m) => [m[1]!, m[2]!] as const);

const SCHEMA_BY_OBJECT: Record<string, ZodType> = {
  connection: PartnerConnectionSchema,
  wallet_balance: WalletBalance,
  wallet_load: WalletLoad,
  list: WalletLoadList,
  statement: Statement,
  test_live_code: TestLiveCode,
};

describe('guías completas (PR 8 B)', () => {
  const es = chapters('es');
  const en = chapters('en');

  it('los capítulos 00 a 08, en los dos idiomas', () => {
    expect([...es.keys()].sort()).toEqual(ALL);
    expect([...en.keys()].sort()).toEqual(ALL);
  });

  it.each(ALL)('capítulo %s: los mismos bloques de código y en el mismo orden', (num) => {
    expect(codeBlocks(body('es', es.get(num)!))).toEqual(codeBlocks(body('en', en.get(num)!)));
  });

  it.each(ALL)('capítulo %s: empieza en su «## N.» (el índice, en su título)', (num) => {
    for (const lang of ['es', 'en'] as const) {
      const first = body(lang, chapters(lang).get(num)!).split('\n')[0]!;
      expect(first, `${lang}/${num}`).toMatch(num === '00' ? /^# / : new RegExp(`^## ${Number(num)}\\. `));
    }
  });

  it('capítulo 5: la tabla nombra exactamente los códigos de PARTNER_ERRORS (44)', () => {
    const codes = Object.keys(PARTNER_ERRORS);
    expect(codes).toHaveLength(44);
    for (const lang of ['es', 'en'] as const) {
      const rows = body(lang, chapters(lang).get('05')!)
        .split('\n')
        .map((l) => /^\| `([a-z_0-9]+)`/.exec(l)?.[1])
        .filter((c): c is string => c !== undefined);
      expect([...new Set(rows)].sort(), lang).toEqual([...codes].sort());
    }
  });

  it('cada bloque json pasa entero el esquema de su `object` (o Problem si lleva `code`)', () => {
    let seen = 0;
    for (const lang of ['es', 'en'] as const) {
      for (const file of chapters(lang).values()) {
        for (const [info, text] of codeBlocks(body(lang, file))) {
          if (info !== 'json') continue;
          const b = JSON.parse(text) as Record<string, unknown>;
          const schema = 'code' in b ? PartnerProblemSchema : SCHEMA_BY_OBJECT[String(b.object)];
          expect(schema, `${lang}/${file}: object ${String(b.object)} sin esquema`).toBeDefined();
          expect(schema!.parse(b), `${lang}/${file}`).toEqual(b);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('los enlaces relativos llevan a ficheros que existen', () => {
    for (const lang of ['es', 'en'] as const) {
      for (const file of chapters(lang).values()) {
        const text = body(lang, file).replace(/^```[\s\S]*?^```$/gm, '');
        for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          const href = m[1]!;
          if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
          const target = resolve(dirname(join(GUIDES, lang, file)), href.split('#')[0]!);
          expect(existsSync(target), `${lang}/${file} → ${href}`).toBe(true);
        }
      }
    }
  });

  it('el índice: el primer párrafo es el de la devolución, y enlaza los capítulos 1 a 8', () => {
    for (const lang of ['es', 'en'] as const) {
      const text = body(lang, chapters(lang).get('00')!);
      const firstParagraph = text.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'));
      if (lang === 'es') expect(firstParagraph).toMatch(/^\*\*No hay devolución ni retirada en efectivo del saldo\.\*\* /);
      const links = [...text.matchAll(/\]\((0[1-8]-[a-z0-9-]+\.md)\)/g)].map((m) => m[1]!);
      expect(links, lang).toEqual(ALL.slice(1).map((n) => chapters(lang).get(n)!));
    }
  });
});
