import { describe, expect, it } from 'vitest';
import { CHOOSE_CSS, renderChooseBody } from './pay-choose-page';
import { choosePayPage, type PayRedirect } from './pay-redirect';

/**
 * La barra de pagar pegada abajo no tapa el desglose:
 *  - su fondo es el del tema (opaco) y solo un degradado corto por encima, que
 *    cae en el hueco entre el desglose y la barra (lo que pasa por debajo no se
 *    ve «roto» detrás de un fondo a medias);
 *  - las propinas van en una sola fila (4 botones de ≥ 48 px) y la explicación
 *    de la comisión no parte la fila: en 360×740 el desglose entero con el
 *    TOTAL cabe por encima de la barra al abrir la página (medido en
 *    scratchpad/cliente/medir: 393×852 y 360×740, 4 idiomas).
 */

/** El bloque de CSS de un selector (el primero; con `inMedia`, el de dentro de la consulta de pantallas bajas). */
function rule(selector: string, inMedia = false): string {
  const media = CHOOSE_CSS.indexOf('@media (max-height:780px){');
  const css = inMedia ? CHOOSE_CSS.slice(media) : CHOOSE_CSS.slice(0, media);
  const at = css.indexOf(`\n${selector}{`);
  if (at < 0) throw new Error(`sin regla ${selector}${inMedia ? ' (pantallas bajas)' : ''}`);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

const rem = (decl: string, prop: string): number => {
  const m = new RegExp(`(?:^|;)${prop}:([0-9.]+)rem`).exec(decl);
  if (!m) throw new Error(`sin ${prop} en «${decl}»`);
  return Number(m[1]);
};

describe('barra de pagar pegada abajo', () => {
  it('fondo opaco del tema, pegada al borde de abajo', () => {
    const bar = rule('.paybar');
    expect(bar).toContain('position:sticky');
    expect(bar).toContain('bottom:0');
    expect(bar).toContain('background:var(--bg)');
    expect(bar).not.toContain('gradient');
  });

  it('el degradado es corto, va por encima de la barra y cabe en el hueco con el desglose (no tapa el TOTAL)', () => {
    const fade = rule('.paybar::before');
    expect(fade).toContain('position:absolute');
    expect(fade).toContain('bottom:100%');
    expect(fade).toContain('pointer-events:none');
    expect(fade).toMatch(/background:linear-gradient\(to top,var\(--bg\),rgb\(9 21 24\/0\)\)/);
    const height = rem(fade, 'height');
    expect(height).toBeLessThanOrEqual(1);
    // El hueco entre el desglose y la barra (gap del formulario) es al menos el degradado.
    expect(rem(rule('form'), 'gap')).toBeGreaterThanOrEqual(height);
    expect(rem(rule('form', true), 'gap')).toBeGreaterThanOrEqual(height);
  });

  it('propinas en una fila de 4 («Sin propina», más ancha) con toques de ≥ 48 px (también en pantallas bajas)', () => {
    expect(rule('.tipgrid')).toMatch(/grid-template-columns:1\.\d+fr 1fr 1fr 1fr/);
    expect(rem(rule('.tipgrid span'), 'min-height')).toBeGreaterThanOrEqual(3);
    expect(rem(rule('.tipgrid span', true), 'min-height')).toBeGreaterThanOrEqual(3);
    // La elegida se ve sin depender del color: invertida (Grafito: fondo --fg, texto --bg) y con su ✓ en una chapa.
    expect(rule('.tipgrid input:checked+span')).toContain('background:var(--fg);color:var(--bg)');
    expect(rule('.tipgrid input:checked+span::after')).toContain('url("data:image/svg+xml');
  });

  it('botones de pagar con ≥ 48 px de toque también en pantallas bajas', () => {
    expect(rem(rule('.paybar .btn', true), 'min-height')).toBeGreaterThanOrEqual(3);
    expect(rem(rule('.paybar .alts .btn', true), 'min-height')).toBeGreaterThanOrEqual(3);
  });

  it('«Otra»: Intro no paga (cierra el teclado) y, al acabar de escribir, el TOTAL se deja ver por encima de la barra', () => {
    const view = choosePayPage({
      id: '11111111-2222-4333-8444-555555555555',
      status: 'CREATED',
      amountCents: 3300,
      serviceFeeCents: 330,
      serviceFeeBps: 1000,
      tipCents: 0,
      currency: 'EUR',
      qrExpiresAt: new Date(Date.now() + 300_000),
      authorizedAt: null,
      allowTip: true,
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
    }) as Extract<PayRedirect, { kind: 'choose' }>;
    const html = renderChooseBody(view, { token: 't', lang: 'es', device: { wallet: 'Apple Pay', inApp: null }, statementName: null, now: new Date() });
    expect(html).toContain("inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();inp.blur();}});");
    expect(html).toContain("inp.addEventListener('change',reveal);");
    expect(html).toContain("var gap=b.getBoundingClientRect().bottom-(bar.getBoundingClientRect().top-16);");
  });
});
