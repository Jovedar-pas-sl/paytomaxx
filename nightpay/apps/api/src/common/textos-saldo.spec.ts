import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guardia estática del vocabulario: al usuario se le dice «Saldo/Saldos»,
 * nunca «Wallet(s)» (decisión del dueño). Mira todo el texto que se enseña:
 * los literales y el JSX de las apps (panel, personal, TPV, cliente, ui y
 * contratos) y los mensajes del API (excepciones, avisos e incidencias,
 * Telegram, CSV, páginas del cliente).
 *
 * No mira lo que no ve nadie: nombres internos (tablas, rutas, claves y
 * códigos: una sola palabra en minúsculas o en MAYÚSCULAS), el SQL, los
 * registros del servidor (logger, console), la ayuda de las métricas, la
 * configuración de arranque ni los `new Error(...)` del API (en producción el
 * cliente recibe un 500 sin el texto). Las marcas (Google Wallet, Apple
 * Wallet, Trust Wallet, Hyperwallet) se quedan como son.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const DIRS = [
  'apps/api/src',
  'apps/admin/src',
  'apps/operator/src',
  'apps/tpv/src',
  'apps/web-client/src',
  'packages/ui/src',
  'packages/contracts/src',
];

/** «wallet»/«wallets» como palabra suelta (no dentro de rutas, claves ni identificadores). */
const WALLET_WORD = /(?<![\w./-])wallets?(?![\w/=-]|\.\w)/i;
const BRANDS = /\b(?:Google|Apple|Trust) Wallet\b/gi;
const SQL = /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|JOIN)\b/;
const LOG_CALL = /(?:^|\.)(?:logger|console)\.\w+$/;

/**
 * El monedero de cripto (Binance, USDT…) donde cobran las chicas: es otra
 * cosa que el saldo del cliente y ahí «wallet» es la palabra de su mundo.
 */
const PAYOUT_WALLET_FILES = new Set([
  'apps/admin/src/components/OnboardingForm.tsx',
  'apps/admin/src/components/PayoutMethodForm.tsx',
  'apps/operator/src/app/onboarding/[token]/PayoutSection.tsx',
  'apps/operator/src/app/onboarding/[token]/SelfOnboardingClient.tsx',
]);

/**
 * La API de socios (contracts/partner): su contrato y su documentación van en
 * inglés, para quien programa otra plataforma, y ahí «wallet» es la palabra del
 * contrato (docs/partner-api/pilot, que manda). Lo que ve el dueño (admin.ts), sí se mira.
 */
const PARTNER_API_DOC = /^packages\/contracts\/src\/partner\/(?!admin\.ts$)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/\.(spec|test)\.tsx?$/.test(f) && !f.includes('generated'))
    .map((f) => `${dir}/${f}`);
}

/** Una sola palabra sin espacios, en minúsculas o en MAYÚSCULAS: un nombre interno (clave, ruta, código). */
function isCodeName(text: string): boolean {
  return !/\s/.test(text) && (!/^[A-Z]/.test(text) || /^[A-Z0-9_]+$/.test(text));
}

/**
 * ¿No lo ve el usuario? La clave de un objeto (un nombre de búsqueda, como el
 * texto viejo de un Z congelado que se traduce al nuevo), o lo envuelve un
 * import, un log, la ayuda de una métrica o un Error del API.
 */
function hidden(node: ts.Node, sf: ts.SourceFile, isApi: boolean): boolean {
  if (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node) return true;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p)) return true;
    if (ts.isCallExpression(p) && LOG_CALL.test(p.expression.getText(sf))) return true;
    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'help') return true;
    if (isApi && ts.isNewExpression(p) && p.expression.getText(sf) === 'Error') return true;
  }
  return false;
}

function shownText(node: ts.Node): string | null {
  if (ts.isJsxText(node)) return node.text.trim() || null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

/** Los textos que se enseñan y dicen «wallet», con su línea. */
function walletTextsIn(file: string, src: string): string[] {
  if (!/wallet/i.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isApi = file.startsWith('apps/api/');
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const text = shownText(node);
    if (text !== null) {
      const prose = text.replace(BRANDS, '');
      if (!isCodeName(prose) && !SQL.test(prose) && WALLET_WORD.test(prose) && !hidden(node, sf, isApi)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push(`${file}:${line}  «${text.replace(/\s+/g, ' ').trim()}»`);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

describe('al usuario se le dice «Saldo/Saldos», nunca «Wallet(s)»', () => {
  it('ningún texto que se enseña dice «wallet»', () => {
    const files = DIRS.flatMap(sourceFiles).filter((f) => !PAYOUT_WALLET_FILES.has(f) && !PARTNER_API_DOC.test(f) && !f.startsWith('apps/api/src/config/'));
    expect(files.length).toBeGreaterThan(500);
    const hits = files.flatMap((f) => walletTextsIn(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('la guardia ve el texto y deja los nombres internos, los registros y las marcas', () => {
    const shown = (code: string, file = 'apps/admin/src/x.tsx') => walletTextsIn(file, code).map((h) => h.replace(/^.*«(.*)»$/, '$1'));
    expect(shown(`const a = <p title="Lista de wallets">Wallets activas</p>;`)).toEqual(['Lista de wallets', 'Wallets activas']);
    expect(shown(`throw new BadRequestException('Wallet no encontrada');`, 'apps/api/src/x.ts')).toEqual(['Wallet no encontrada']);
    expect(shown(`const k = { key: 'wallet', path: '/v1/wallet-charges/', act: 'wallet.block', c: 'WALLET_BLOCKED', s: 'WALLET' };`)).toEqual([]);
    expect(shown(`const b = 'Añadir a Google Wallet'; const h = 'Hyperwallet';`)).toEqual([]);
    expect(shown(`this.logger.log(\`Wallet \${id} creada\`);`, 'apps/api/src/x.ts')).toEqual([]);
    expect(shown(`throw new Error('falta COOKIE_SECRET para la wallet');`, 'apps/api/src/x.ts')).toEqual([]);
    expect(shown(`const q = \`SELECT id FROM client_wallets WHERE "walletId" = \${id}\`;`, 'apps/api/src/x.ts')).toEqual([]);
    // La clave de un objeto es un nombre de búsqueda (el texto viejo que se traduce); su valor sí se enseña.
    expect(shown(`const m = { 'Recarga de wallet': 'Recarga con tarjeta' };`)).toEqual([]);
    expect(shown(`const t = { label: 'Recarga de wallet' };`)).toEqual(['Recarga de wallet']);
  });
});
