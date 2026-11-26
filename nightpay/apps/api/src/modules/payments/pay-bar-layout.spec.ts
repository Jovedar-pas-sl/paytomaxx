import { describe, expect, it } from 'vitest';
import { CHOOSE_CSS, renderChooseBody } from './pay-choose-page';
import { choosePayPage, type PayablePayment, type PayRedirect } from './pay-redirect';
import { TIP_BUTTONS_CSS, TIP_BUTTONS_LOW_CSS } from './tip-buttons';
import { SALDO_TIP_CSS } from '../wallets/saldo-tip';

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

/** La página de pago de un cobro de 33 € con propinas (salvo lo que diga `extra`), con espacios normales en las cifras. */
function body(extra: Partial<PayablePayment>, lang: 'es' | 'en' = 'es'): string {
  const view = choosePayPage({
    id: '11111111-2222-4333-8444-555555555555',
    status: 'CREATED',
    amountCents: 3300,
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
    ...extra,
  }) as Extract<PayRedirect, { kind: 'choose' }>;
  const ctx = { token: 't', lang, device: { wallet: 'Apple Pay' as const, inApp: null }, statementName: null, now: new Date() };
  return renderChooseBody(view, ctx).replace(/[\u00a0\u202f]/g, ' ');
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

  it('propinas en una rejilla de 4 («Sin propina», más ancha; una quinta pasa a otra fila) con botones de 56 px (48 en pantallas bajas)', () => {
    expect(rule('.tipgrid')).toContain('grid-template-columns:1.35fr 1fr 1fr 1fr');
    expect(rem(rule('.tipgrid label>span'), 'min-height')).toBe(3.5);
    expect(rem(rule('.tipgrid label>span', true), 'min-height')).toBe(3);
    // La elegida se ve sin depender del color: invertida (Grafito: fondo --fg, texto --bg) y con su ✓ en una chapa.
    expect(rule('.tipgrid input:checked+span')).toContain('background:var(--fg);color:var(--bg)');
    expect(rule('.tipgrid input:checked+span::after')).toContain('url("data:image/svg+xml');
    // Una sola copia de los botones para /pay y /s (antes, dos que se separaban).
    expect(CHOOSE_CSS).toContain(TIP_BUTTONS_CSS);
    expect(CHOOSE_CSS.slice(CHOOSE_CSS.indexOf('@media (max-height:780px){'))).toContain(TIP_BUTTONS_LOW_CSS);
    expect(SALDO_TIP_CSS).toContain(TIP_BUTTONS_CSS);
    expect(SALDO_TIP_CSS).toContain(`@media (max-height:780px){${TIP_BUTTONS_LOW_CSS}}`);
  });

  it('cada propina: los euros arriba (16/600) y debajo el total con ella (14 px, apagado), sin porcentajes; el lector oye las dos cosas', () => {
    // 33 € con 3,30 € de comisión del servicio y +3 € de propina → 39,30 €.
    const html = body({ amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000, tipPresets: { flatCents: [300, 500] } });
    expect(html).toContain(
      '<label><input type="radio" name="tip" value="300"><span class="num"><span class="sr">Propina de 3 €. Total 39,30 €</span><b aria-hidden="true">+3 €</b><small aria-hidden="true">39,30 €</small></span></label>',
    );
    // «Sin propina» con su total y «Otra» (sin total: aún no se sabe), en la misma caja.
    expect(html).toContain(
      '<label><input type="radio" name="tip" value="0"><span class="word"><span class="sr">Sin propina. Total 36,30 €</span><b aria-hidden="true">Sin propina</b><small aria-hidden="true">36,30 €</small></span></label>',
    );
    expect(html).toContain('<label id="otherOpt" hidden><input type="radio" name="tip" value="0" id="otherRadio"><span class="word"><b>Otra</b></span></label>');
    expect(rule('.tipgrid b')).toContain('font-size:1rem;font-weight:600');
    expect(rule('.tipgrid small')).toContain('font-size:.875rem');
    expect(rule('.tipgrid small')).toContain('color:var(--mute)');
    // Por encima de 40 € las sugeridas salen de un porcentaje, pero el botón dice euros: ningún «%» en las propinas.
    const big = body({ amountCents: 6000 });
    const tips = big.slice(big.indexOf('<fieldset class="tips">'), big.indexOf('</fieldset>'));
    expect(tips).toContain('<b aria-hidden="true">+6 €</b><small aria-hidden="true">66,00 €</small>');
    expect(tips).toContain('<b aria-hidden="true">+9 €</b><small aria-hidden="true">69,00 €</small>');
    expect(tips).not.toContain('%');
    // Con una propina más (la quinta caja), los mismos botones: la rejilla la manda a otra fila.
    const five = body({ amountCents: 6000, tipPresets: { percents: [5, 10, 15] } });
    expect(five.match(/<label[^>]*><input type="radio" name="tip"/g)).toHaveLength(5);
  });

  it('a quién va la propina se dice siempre: «Va entera para el personal» o «Es para el local»', () => {
    expect(body({ tipToStaff: true })).toContain('<p class="tipnote">Va entera para el personal</p>');
    expect(body({ tipToStaff: false })).toContain('<p class="tipnote">Es para el local</p>');
    expect(body({})).toContain('<p class="tipnote">Es para el local</p>');
    expect(body({ tipToStaff: false }, 'en')).toContain('<p class="tipnote">It goes to the venue</p>');
    // Sin propinas en el cobro, ni botones ni frase.
    expect(body({ allowTip: false })).not.toContain('class="tipnote"');
  });

  it('la frase del banco va en la barra de pagar, también en pantallas bajas', () => {
    const html = body({});
    const bar = html.slice(html.indexOf('<div class="paybar">'), html.indexOf('</form>'));
    expect(bar).toContain('La tarjeta la escribes en la página segura del banco, no en OxioPay.');
    expect(bar.indexOf('id="payBtn"')).toBeLessThan(bar.indexOf('class="trust"'));
    expect(CHOOSE_CSS).not.toMatch(/\.trust[^{}]*\{[^}]*display:none/);
  });

  it('botones de pagar con ≥ 48 px de toque también en pantallas bajas', () => {
    expect(rem(rule('.paybar .btn', true), 'min-height')).toBeGreaterThanOrEqual(3);
    expect(rem(rule('.paybar .alts .btn', true), 'min-height')).toBeGreaterThanOrEqual(3);
  });

  it('«Otra»: Intro no paga (cierra el teclado) y, al acabar de escribir, el TOTAL se deja ver por encima de la barra', () => {
    const html = body({ amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000 });
    expect(html).toContain("inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();inp.blur();}});");
    expect(html).toContain("inp.addEventListener('change',reveal);");
    expect(html).toContain("var gap=b.getBoundingClientRect().bottom-(bar.getBoundingClientRect().top-16);");
  });
});
