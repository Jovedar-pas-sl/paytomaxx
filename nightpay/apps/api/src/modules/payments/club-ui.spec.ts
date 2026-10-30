import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OXIOCARD_WORDMARK } from './brand-logo';
import { CLUB_BASE_CSS, CLUB_TOKENS, brandBar, brandWordmark } from './club-ui';
import { PAID_SCREEN_CSS } from './paid-screen';
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

  it('colores de la marca: lima #c7d301 con tinta, noche de fondo; ya no el lima antiguo', () => {
    expect(CLUB_BASE_CSS).toContain('--lime:#c7d301');
    expect(CLUB_BASE_CSS).toContain('--ink:#1f2c36');
    expect(CLUB_BASE_CSS).toContain('--bg:#0f1112');
    expect(CLUB_BASE_CSS).not.toContain('d4ff3a');
    // Botón principal: lima con tinta, con forma de página de pago (esquinas de 12 px, no un cartel en píldora).
    expect(CLUB_BASE_CSS).toContain(':root{--r-btn:12px}');
    expect(CLUB_BASE_CSS).toMatch(/\.btn\{[^}]*border-radius:var\(--r-btn\);[^}]*background:var\(--lime\);color:var\(--ink\)/);
    expect(CLUB_BASE_CSS).not.toContain('999px');
    // Ocupado: su color con la ruedita (no gris); desactivado de verdad: gris.
    expect(CLUB_BASE_CSS).toContain('.btn:disabled:not(.busy),.btn[aria-disabled=true]:not(.busy){background:var(--surface-2)');
    expect(CLUB_BASE_CSS).toContain('.btn.busy::before{');
    expect(CLUB_BASE_CSS.includes(BACKSLASH)).toBe(false);
  });

  it('«Pagado»: el verde de la marca con texto crema y el aro lima (gris si ya no es nuevo)', () => {
    expect(PAID_SCREEN_CSS).toContain('radial-gradient(120% 80% at 50% 32%,var(--green-3) 0%,var(--green-2) 55%,var(--green-1) 100%)');
    expect(PAID_SCREEN_CSS).toContain('color:var(--cream)');
    expect(PAID_SCREEN_CSS).toMatch(/\.paid \.tick\{[^}]*background:var\(--lime\)/);
    expect(PAID_SCREEN_CSS).toContain('.paid.stale{background:var(--stale)');
  });

  it('las páginas llevan el logo y ninguna imagen de otro sitio', () => {
    const pages = [
      renderWalletPage('tok-1', 'es', wallet),
      renderNoticePage('es', PAY_TEXT.es.notFound, 'warn'),
    ];
    for (const html of pages) {
      expect(html).toContain(OXIOCARD_WORDMARK.src);
      expect(html).toContain('<meta name="theme-color" content="#0f1112">');
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
  ])('--%s del cliente = --np-%s', (clubName, npName) => {
    expect(darkStart).toBeGreaterThan(0);
    expect(club(clubName)).toBeDefined();
    expect(club(clubName)).toBe(np(dark, npName));
  });

  it.each([
    ['lime', 'lime'],
    ['ink', 'ink'],
    ['cream', 'cream'],
    ['green-1', 'green-1'],
    ['green-2', 'green-2'],
    ['green-3', 'green-3'],
  ])('marca: --%s del cliente = --np-%s', (clubName, npName) => {
    expect(club(clubName)).toBe(np(base, npName));
  });

  it('el halo del lima, igual de contenido que en las apps', () => {
    expect(CLUB_TOKENS).toContain('--lime-glow:rgb(199 211 1/.32)');
    expect(styles).toContain('--np-lime-glow: rgb(199 211 1 / 0.32)');
  });
});
