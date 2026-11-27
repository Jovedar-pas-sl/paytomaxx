import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { MONEY_SCOPES, PARTNER_ROUTES } from '@nightpay/contracts';

/**
 * Cableado de la API de socios (lectura estática, sin arrancar Nest): las
 * rutas `partner` y `partner/…` solo existen con @PartnerRoute(PARTNER_ROUTES.x)
 * (así cada una pasa por la clave, el interceptor y la documentación) y cada
 * entrada de la tabla tiene su ruta; `scopes: []` (sin clave) solo en
 * openapi.json; `money` solo con permisos de dinero; y el módulo nunca cruza
 * locales con acrossVenues.
 */

const MODULES_DIR = join(__dirname, '..');
const PARTNER_DIR = __dirname;
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);

interface Found {
  label: string;
  basePath: string;
  http: string[];
  partnerRoute: string | null;
}

function tsFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(suffix) && !f.endsWith('.spec.ts'))
    .map((f) => join(dir, f));
}

function decorators(node: ts.Node): Array<{ name: string; args: ts.Expression[] }> {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).flatMap((d) => {
    const e = d.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return [{ name: e.expression.text, args: [...e.arguments] }];
    return ts.isIdentifier(e) ? [{ name: e.text, args: [] }] : [];
  });
}

function routes(): Found[] {
  return tsFiles(MODULES_DIR, '.controller.ts').flatMap((file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    return sf.statements.filter(ts.isClassDeclaration).flatMap((cls) => {
      const controller = decorators(cls).find((d) => d.name === 'Controller');
      if (!controller) return [];
      const base = controller.args[0];
      const basePath = base && ts.isStringLiteralLike(base) ? base.text : '';
      return cls.members.filter(ts.isMethodDeclaration).flatMap((m) => {
        const decos = decorators(m);
        const pr = decos.find((d) => d.name === 'PartnerRoute');
        const http = decos.filter((d) => HTTP_DECORATORS.has(d.name)).map((d) => d.name);
        if (!pr && http.length === 0) return [];
        const arg = pr?.args[0];
        const partnerRoute =
          arg && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'PARTNER_ROUTES'
            ? arg.name.text
            : pr
              ? '<otra cosa>'
              : null;
        return [{ label: `${cls.name?.text ?? '?'}.${m.name.getText()}`, basePath, http, partnerRoute }];
      });
    });
  });
}

const all = routes();
const isPartnerBase = (b: string) => b === 'partner' || b.startsWith('partner/');

describe('cableado de la API de socios', () => {
  it('se encuentran las rutas', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((r) => r.partnerRoute !== null).length).toBeGreaterThan(0);
  });

  it('una ruta partner o partner/… solo con @PartnerRoute(PARTNER_ROUTES.x), sin @Get/@Post sueltos', () => {
    const bad = all.filter((r) => isPartnerBase(r.basePath) && (r.http.length > 0 || r.partnerRoute === null || r.partnerRoute === '<otra cosa>'));
    expect(bad.map((r) => r.label)).toEqual([]);
  });

  it('@PartnerRoute solo en controladores partner (nunca en otra parte)', () => {
    expect(all.filter((r) => r.partnerRoute !== null && !isPartnerBase(r.basePath)).map((r) => r.label)).toEqual([]);
  });

  it('cada entrada de PARTNER_ROUTES tiene exactamente una ruta, y al revés', () => {
    const used = all.filter((r) => r.partnerRoute !== null).map((r) => r.partnerRoute);
    expect([...used].sort()).toEqual(Object.keys(PARTNER_ROUTES).sort());
  });

  it('scopes: [] (sin clave) solo en getOpenApi; money solo con permisos de dinero', () => {
    const entries = Object.entries(PARTNER_ROUTES) as Array<[string, { scopes: readonly string[]; money: boolean }]>;
    expect(entries.filter(([, d]) => d.scopes.length === 0).map(([n]) => n)).toEqual(['getOpenApi']);
    const money = new Set<string>(MONEY_SCOPES);
    expect(entries.filter(([, d]) => d.money && (d.scopes.length === 0 || d.scopes.some((s) => !money.has(s)))).map(([n]) => n)).toEqual([]);
  });

  it('modules/partner nunca usa acrossVenues (una clave es de un local)', () => {
    const offenders = tsFiles(PARTNER_DIR, '.ts').filter((f) => /\bacrossVenues\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
