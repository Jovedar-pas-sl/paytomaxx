import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OXIOPAY_WORDMARK } from './brand-logo';
import { CLUB_BASE_CSS, CLUB_TOKENS, brandBar, brandWordmark } from './club-ui';
import { CHROME_CSS } from './customer-chrome';
import { PAID_SCREEN_CSS } from './paid-screen';
import { BREAKDOWN_CSS, CHOOSE_CSS } from './pay-choose-page';
import { renderNoticePage } from './public-pay.pages';
import { PAY_TEXT } from './pay-i18n';
import { renderWalletPage } from '../wallets/wallet-page';
import type { ClientWalletState } from '../wallets/wallet-charges.service';

const BACKSLASH = String.fromCharCode(92);

const wallet: ClientWalletState = {
  code: 'K7Q-4M2',
  balanceCents: 3000,
  status: 'ACTIVE',
  closeRequested: false,
  hasFaceId: false,
  hasPin: false,
  hasCard: false,
  merged: false,
  refund: null,
  cards: [],
  movements: [],
};

describe('marca OxioPay en las páginas del cliente', () => {
  it('el logo va dentro de la página (data: PNG): la CSP del API no deja cargar imágenes de fuera', () => {
    expect(OXIOPAY_WORDMARK.src.startsWith('data:image/png;base64,iVBOR')).toBe(true);
    expect(OXIOPAY_WORDMARK.src.includes(BACKSLASH)).toBe(false);
    const img = brandWordmark();
    expect(img).toContain('alt="OxioPay"');
    expect(img).toContain('width="256" height="51"');
    expect(brandWordmark('<b>')).toContain('alt="&lt;b&gt;"');
    expect(brandBar()).toContain('<header class="brand">');
  });

  it('colores de la marca: lima #c7d301 con su tinta, el suelo de «Color y relieve»; ya no el lima antiguo', () => {
    expect(CLUB_BASE_CSS).toContain('--lime:#c7d301');
    expect(CLUB_BASE_CSS).toContain('--on-lime:#091518');
    expect(CLUB_BASE_CSS).toContain('--bg:#091518');
    expect(CLUB_BASE_CSS).not.toContain('d4ff3a');
    // Botón principal («Color y relieve», 25-nov-2026): el mismo que el de las
    // apps. Antes, lima plana con esquinas de 14 px, sin brillo ni halo (Grafito);
    // ahora, píldora con el brillo arriba y la sombra con resplandor lima.
    expect(CLUB_BASE_CSS).toMatch(
      /\.btn\{[^}]*border-radius:999px;[^}]*background:var\(--lime\) linear-gradient\(180deg,rgba\(255,255,255,\.24\),rgba\(255,255,255,0\) 55%\);color:var\(--on-lime\)/,
    );
    expect(CLUB_BASE_CSS).toMatch(
      /\.btn\{[^}]*box-shadow:inset 0 1px 0 rgba\(255,255,255,\.45\),inset 0 -1px 0 rgba\(0,0,0,\.18\),0 1px 2px rgba\(0,0,0,\.4\),0 8px 24px -8px rgba\(199,211,1,\.5\)/,
    );
    // El secundario y el apagado no heredan el resplandor lima.
    expect(CLUB_BASE_CSS).toMatch(/\.btn\.alt\{[^}]*box-shadow:inset 0 1px 0 rgba\(239,233,223,\.08\)/);
    // Con comas: rgb() con espacios es de Chrome 65 y, en uno más viejo, un fondo
    // «lima + degradado» con él no se pintaba entero (el botón se quedaba sin color).
    for (const m of CLUB_BASE_CSS.matchAll(/(\.btn[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]).not.toMatch(/rgba?\(\d+ \d+ \d+/);
    expect(CLUB_BASE_CSS).toMatch(/\.btn:disabled:not\(\.busy\),\.btn\[aria-disabled=true\]:not\(\.busy\)\{[^}]*box-shadow:none/);
    // Solo los botones son píldora: lo partido en dos (--r-btn), las losetas, los campos y los chips siguen con su radio.
    expect(CLUB_BASE_CSS).toContain(':root{--r-btn:14px}');
    expect(CLUB_TOKENS).toContain('--r:18px;--r-tile:14px;--r-field:10px;--r-chip:6px');
    // Ocupado: su color con la ruedita (no gris); desactivado de verdad: gris.
    expect(CLUB_BASE_CSS).toContain('.btn:disabled:not(.busy),.btn[aria-disabled=true]:not(.busy){background:var(--surface-2)');
    expect(CLUB_BASE_CSS).toContain('.btn.busy::before{');
    expect(CLUB_BASE_CSS.includes(BACKSLASH)).toBe(false);
  });

  it('ninguna regla .btn de ninguna hoja del API pinta su fondo o su sombra con rgb() con espacios (revisión del PR #63)', () => {
    // Un navegador anterior a Chrome 65 / iOS 12.2 descarta esa declaración entera: el botón
    // blanco de bitcoin y el de Google Pay se quedaban con el resplandor lima que .btn trae de serie.
    // Regla que queda: quien cambie el fondo de un .btn pone su propio box-shadow, con comas.
    const src = join(__dirname, '..', '..');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const rules: string[] = [];
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(src, f), 'utf8').matchAll(/(\.btn[^{}`'"]*)\{([^}`]*)\}/g)) {
        if (!/box-shadow|background/.test(m[2]!)) continue;
        rules.push(m[1]!);
        if (/rgba?\(\d+ \d+ \d+/.test(m[2]!)) bad.push(`${f.replace(/\\/g, '/')}: ${m[1]}`);
      }
    }
    // Las mira de verdad: las de club-ui, las de la página de elegir pago y las de «He perdido mi NFC».
    for (const selector of ['.btn', '.btn.alt', '.btn.btc', '.btn.gpay', '.btn.redo', '.btn.red']) expect(rules).toContain(selector);
    expect(bad).toEqual([]);
    expect(CHOOSE_CSS).toContain('.btn.btc{background:#fff;border-color:#fff;color:#000;box-shadow:0 1px 2px rgba(0,0,0,.35);');
    expect(CHOOSE_CSS).toContain('.btn.gpay{background:#fff;border-color:#fff;color:#1f1f1f;box-shadow:0 1px 2px rgba(0,0,0,.35)}');
  });

  it('«Pagado»: verde plano con texto claro, la marca lima sin halo y la placa crema (gris si ya no es nuevo)', () => {
    expect(CLUB_TOKENS).toContain('--paid:#0b3d24');
    expect(PAID_SCREEN_CSS).toMatch(/\.paid\{[^}]*background:var\(--paid\);color:var\(--paid-ink\)/);
    expect(PAID_SCREEN_CSS).not.toContain('gradient');
    expect(PAID_SCREEN_CSS).toMatch(/\.paid \.tick\{[^}]*background:var\(--lime\)/);
    expect(PAID_SCREEN_CSS).not.toMatch(/\.paid \.tick\{[^}]*box-shadow/);
    expect(PAID_SCREEN_CSS).toMatch(/\.paid \.pcode\{[^}]*background:var\(--cream\);color:var\(--ink\)/);
    expect(PAID_SCREEN_CSS).toContain('.paid.stale{background:var(--stale)');
  });

  it('Grafito: una letra para el texto, cifras en Manrope, nunca 800 ni 900 y sin mayúsculas de adorno', () => {
    expect(CLUB_BASE_CSS).toMatch(/body\{[^}]*font:400 16px\/1\.5 var\(--sans\)/);
    for (const css of [CLUB_BASE_CSS, CHROME_CSS, PAID_SCREEN_CSS, CHOOSE_CSS]) {
      expect(css).not.toMatch(/font-weight:\s*[89]00/);
      expect(css).not.toMatch(/font:\s*[89]00/);
      expect(css).not.toContain('text-transform:uppercase');
    }
    // Los antetítulos y el total, sin lima: la lima es solo lo que hay que tocar.
    expect(CLUB_BASE_CSS).toMatch(/\.kick\{[^}]*color:var\(--label\)/);
    expect(BREAKDOWN_CSS).toMatch(/\.brk \.tot dd\{[^}]*color:var\(--fg\)/);
    expect(BREAKDOWN_CSS).not.toContain('var(--lime)');
  });

  it('las páginas llevan el logo y ninguna imagen de otro sitio', () => {
    const pages = [
      renderWalletPage('tok-1', 'es', wallet),
      renderNoticePage('es', PAY_TEXT.es.notFound, 'warn'),
    ];
    for (const html of pages) {
      expect(html).toContain(OXIOPAY_WORDMARK.src);
      expect(html).toContain('<meta name="theme-color" content="#091518">');
      expect(html).not.toMatch(/src="https?:/);
    }
  });
});

describe('las fichas del cliente son las del tema oscuro de @nightpay/ui (no se separan)', () => {
  // Sin \r: en Windows git deja los ficheros con CRLF.
  const styles = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'packages', 'ui', 'src', 'styles.css'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const darkStart = styles.indexOf(":root,\n[data-theme='dark'] {");
  const dark = styles.slice(darkStart, styles.indexOf('\n}', darkStart));
  const base = styles.slice(styles.indexOf(':root {'), styles.indexOf('\n}', styles.indexOf(':root {')));
  const np = (block: string, name: string): string | undefined =>
    new RegExp(`--np-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(block)?.[1]?.toLowerCase();
  const club = (name: string): string | undefined => new RegExp(`--${name}:(#[0-9a-f]{6})`, 'i').exec(CLUB_TOKENS)?.[1]?.toLowerCase();

  it.each([
    ['bg', 'bg'],
    ['surface', 'surface'],
    ['surface-2', 'surface-2'],
    ['surface-3', 'surface-3'],
    ['line', 'border'],
    ['line-hi', 'border-hi'],
    ['fg', 'text'],
    ['mute', 'text-mute'],
    ['dim', 'text-dim'],
    ['label', 'text-label'],
    ['err', 'danger-text'],
    ['bad', 'danger'],
    ['ok', 'success'],
    ['warn', 'warning'],
    ['on-lime', 'on-accent'],
  ])('--%s del cliente = --np-%s', (clubName, npName) => {
    expect(darkStart).toBeGreaterThan(0);
    expect(club(clubName)).toBeDefined();
    expect(club(clubName)).toBe(np(dark, npName));
  });

  it.each([
    ['lime', 'lime'],
    ['ink', 'ink'],
    ['cream', 'cream'],
    ['paid', 'outcome-paid'],
    ['paid-ink', 'outcome-paid-ink'],
    ['fail', 'outcome-failed'],
  ])('marca y resultados: --%s del cliente = --np-%s', (clubName, npName) => {
    expect(club(clubName)).toBeDefined();
    expect(club(clubName)).toBe(np(base, npName));
  });

  it('sin halos, degradados verdes ni 0101, como en las apps', () => {
    expect(styles).toContain('--np-lime-glow: transparent;');
    expect(styles).toContain('--np-bits: none;');
    for (const gone of ['--lime-glow', '--lime-ring', '--lime-soft', '--lime-edge', '--green-', '--bits', '0101']) {
      expect(CLUB_TOKENS).not.toContain(gone);
    }
  });
});
