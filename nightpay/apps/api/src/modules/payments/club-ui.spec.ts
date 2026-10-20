import { describe, expect, it } from 'vitest';
import { OXIOCARD_WORDMARK } from './brand-logo';
import { CLUB_BASE_CSS, brandBar, brandWordmark } from './club-ui';
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
    // Botón principal: pill lima con tinta.
    expect(CLUB_BASE_CSS).toMatch(/\.btn\{[^}]*border-radius:999px;[^}]*background:var\(--lime\);color:var\(--ink\)/);
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
