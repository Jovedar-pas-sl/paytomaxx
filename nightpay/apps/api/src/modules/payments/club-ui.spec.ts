import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OXIOCARD_WORDMARK } from './brand-logo';
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

describe('marca OxioCard en las páginas del cliente', () => {
  it('el logo va dentro de la página (data: PNG): la CSP del API no deja cargar imágenes de fuera', () => {
    expect(OXIOCARD_WORDMARK.src.startsWith('data:image/png;base64,iVBOR')).toBe(true);
    expect(OXIOCARD_WORDMARK.src.includes(BACKSLASH)).toBe(false);
    const img = brandWordmark();
    expect(img).toContain('alt="OxioCard"');
    expect(img).toContain('width="269" height="43"');
    expect(brandWordmark('<b>')).toContain('alt="&lt;b&gt;"');
    expect(brandBar()).toContain('<header class="brand">');
  });

  it('colores de la marca: lima #c7d301 con su tinta, fondo Grafito; ya no el lima antiguo', () => {
    expect(CLUB_BASE_CSS).toContain('--lime:#c7d301');
    expect(CLUB_BASE_CSS).toContain('--on-lime:#11160a');
    expect(CLUB_BASE_CSS).toContain('--bg:#0b0d0e');
    expect(CLUB_BASE_CSS).not.toContain('d4ff3a');
    // Botón principal: lima plana con su tinta, esquinas de 14 px (Grafito: botones del móvil), sin brillo ni halo.
    expect(CLUB_BASE_CSS).toContain(':root{--r-btn:14px}');
    expect(CLUB_BASE_CSS).toMatch(/\.btn\{[^}]*border-radius:var\(--r-btn\);[^}]*background:var\(--lime\);color:var\(--on-lime\)/);
    expect(CLUB_BASE_CSS).not.toMatch(/\.btn\{[^}]*box-shadow/);
    expect(CLUB_BASE_CSS).not.toContain('999px');
    // Ocupado: su color con la ruedita (no gris); desactivado de verdad: gris.
    expect(CLUB_BASE_CSS).toContain('.btn:disabled:not(.busy),.btn[aria-disabled=true]:not(.busy){background:var(--surface-2)');
    expect(CLUB_BASE_CSS).toContain('.btn.busy::before{');
    expect(CLUB_BASE_CSS.includes(BACKSLASH)).toBe(false);
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
      expect(html).toContain(OXIOCARD_WORDMARK.src);
      expect(html).toContain('<meta name="theme-color" content="#0b0d0e">');
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
