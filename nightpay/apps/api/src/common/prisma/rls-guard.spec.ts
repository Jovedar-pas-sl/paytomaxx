import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { FORCED_RLS_TABLES } from './rls';

/**
 * Guardia estática: las tablas con FORCE RLS solo se tocan dentro de una
 * transacción de PrismaService (withTenant, asSystem, acrossVenues o
 * $transaction), que es donde va el local (o el bypass) en la sesión. Con el
 * rol de producción sin superusuario, una consulta fuera de ella no ve filas.
 *
 * Mira todo src/ (sin las pruebas) y falla si:
 *  1. SQL crudo que nombra una de esas tablas (o usa afterPayoutDebt) va por
 *     el cliente raíz (this.prisma / prisma) en vez de por la transacción;
 *  2. se usa el modelo de una de esas tablas en el cliente raíz
 *     (this.prisma.clientWallet.findMany…);
 *  3. se pasa el cliente raíz a una función que espera una transacción.
 * Lo que no ve (relaciones en include/select, helpers llamados con otra
 * cosa) lo para en marcha el middleware de PrismaService (métrica
 * nightpay_rls_outside_transaction_total; con TENANCY_UNSCOPED_QUERIES=throw,
 * error; las pruebas de integración van así).
 */

const SRC = join(__dirname, '..', '..');
const ROOT_CLIENTS = new Set(['this.prisma', 'prisma']);
const RAW_METHODS = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']);
const FORCED_DELEGATES = new Set([
  'clientWallet',
  'walletConsumption',
  'operatorEarning',
  'operatorPayout',
  'earningReversal',
  'peanpeCall',
  'approvalRequest',
]);
const FORCED_SQL = new RegExp(`\\b(${FORCED_RLS_TABLES.join('|')})\\b|afterPayoutDebt\\(`);
/** Tipo de parámetro que dice «esto es una transacción». */
const TX_PARAM_TYPE = /\bTransactionalClient\b|\bPrisma\.TransactionClient\b|\b\w*Tx\b/;

interface Finding {
  file: string;
  line: number;
  rule: string;
  code: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts') && !f.includes('generated'))
    .map((f) => join(dir, f));
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Nombres de las funciones y métodos de src/ con un parámetro de tipo transacción. */
function txHelpers(files: ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const sf of files) {
    walk(sf, (n) => {
      if (!ts.isFunctionDeclaration(n) && !ts.isMethodDeclaration(n) && !ts.isArrowFunction(n)) return;
      const takesTx = n.parameters.some((p) => p.type && TX_PARAM_TYPE.test(p.type.getText(sf)));
      if (!takesTx) return;
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) names.add(n.name.getText(sf));
      if (ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent)) names.add(n.parent.name.getText(sf));
    });
  }
  return names;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Las tres reglas sobre un fichero; `report` recibe el nodo y la regla. */
function check(sf: ts.SourceFile, helpers: Set<string>, report: (n: ts.Node, rule: string) => void): void {
  const viaRoot = (receiver: ts.Expression): boolean => ROOT_CLIENTS.has(receiver.getText(sf));
  walk(sf, (n) => {
    // 1. SQL crudo con una tabla con FORCE RLS por el cliente raíz.
    if (ts.isTaggedTemplateExpression(n) && ts.isPropertyAccessExpression(n.tag) && RAW_METHODS.has(n.tag.name.text)) {
      if (viaRoot(n.tag.expression) && FORCED_SQL.test(n.template.getText(sf))) report(n, 'sql-raiz');
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && RAW_METHODS.has(n.expression.name.text)) {
      if (viaRoot(n.expression.expression) && FORCED_SQL.test(n.arguments[0]?.getText(sf) ?? '')) report(n, 'sql-raiz');
    }
    // 2. Modelo con FORCE RLS en el cliente raíz.
    if (ts.isPropertyAccessExpression(n) && FORCED_DELEGATES.has(n.name.text) && viaRoot(n.expression)) {
      report(n, 'modelo-raiz');
    }
    // 3. El cliente raíz a una función que espera una transacción.
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name && helpers.has(name) && n.arguments.some(viaRoot)) report(n, 'raiz-como-transaccion');
    }
  });
}

function findViolations(): Finding[] {
  const files = sourceFiles(SRC).map(parse);
  const helpers = txHelpers(files);
  const out: Finding[] = [];
  for (const sf of files) {
    const file = relative(SRC, sf.fileName).split('\\').join('/');
    check(sf, helpers, (n, rule) => {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      out.push({ file, line, rule, code: n.getText(sf).split('\n')[0]!.slice(0, 120) });
    });
  }
  return out;
}

describe('guardia: tablas con FORCE RLS solo dentro de una transacción', () => {
  it('ningún sitio de src/ las toca por el cliente raíz', () => {
    const found = findViolations();
    const listado = found.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.code}`).join('\n');
    expect(found, `Usa prisma.withTenant(local, tx => …), asSystem o acrossVenues:\n${listado}`).toEqual([]);
  });

  it('la guardia ve lo que tiene que ver (comprobación de la propia guardia)', () => {
    const sf = ts.createSourceFile(
      'x.ts',
      [
        'async function lock(tx: TransactionalClient) { return tx.$queryRaw`SELECT 1 FROM client_wallets`; }',
        'class S {',
        '  a() { return this.prisma.$queryRaw<X[]>`SELECT * FROM operator_earnings`; }',
        '  b() { return this.prisma.$queryRawUnsafe(`SELECT ${afterPayoutDebt("e")} FROM payments e`); }',
        '  c() { return this.prisma.peanpeCall.findUnique({ where: {} }); }',
        '  d() { return lock(this.prisma); }',
        '  ok() { return this.prisma.withTenant(t, (tx) => tx.$queryRaw`SELECT 1 FROM operator_payouts`); }',
        '  ok2() { return this.prisma.$queryRaw`SELECT 1 FROM payments`; }',
        '}',
      ].join('\n'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const helpers = txHelpers([sf]);
    expect([...helpers]).toEqual(['lock']);
    const rules: string[] = [];
    check(sf, helpers, (_n, rule) => rules.push(rule));
    expect(rules.sort()).toEqual(['modelo-raiz', 'raiz-como-transaccion', 'sql-raiz', 'sql-raiz']);
  });
});
