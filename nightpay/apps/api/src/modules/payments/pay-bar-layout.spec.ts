import { describe, expect, it } from 'vitest';
import { CLUB_TOKENS } from './club-ui';
import { CHOOSE_CSS, CROWDED_CSS, SOON_CSS, renderChooseBody } from './pay-choose-page';
import { renderChoosePage } from './public-pay.pages';
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
function body(extra: Partial<PayablePayment>, lang: 'es' | 'en' | 'fr' | 'pt' = 'es', now: Date = new Date()): string {
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
  const ctx = { token: 't', lang, device: { wallet: 'Apple Pay' as const, inApp: null }, statementName: null, now };
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

describe('caducidad: en el último minuto, el aviso en ámbar (idea 65)', () => {
  const NOW = new Date('2026-11-26T22:00:00Z');
  const at = (seconds: number, lang: 'es' | 'en' | 'fr' | 'pt' = 'es'): string =>
    body({ qrExpiresAt: new Date(NOW.getTime() + seconds * 1000) }, lang, NOW);

  it('con más de un minuto: «Caduca en 4:58», como siempre; el aviso va en la página, oculto', () => {
    const html = at(298);
    expect(html).toContain('<span id="exp">Caduca en <b class="num" id="left">4:58</b></span>');
    expect(html).toContain('<span class="soon" id="soon" hidden>');
    expect(at(61)).toContain('<span class="soon" id="soon" hidden>');
  });

  it('abierta con 60 s o menos, el servidor ya la pinta con el aviso (también sin JS)', () => {
    const html = at(42);
    expect(html).toContain('<span id="exp" hidden>');
    expect(html).toContain('<span class="soon" id="soon">Queda menos de 1 minuto: 0:42. Si caduca, pide otro QR.</span>');
    expect(at(60)).toContain('<span class="soon" id="soon">Queda menos de 1 minuto: 1:00. Si caduca, pide otro QR.</span>');
    expect(at(42, 'en')).toContain('Less than 1 minute left: 0:42. If it expires, ask for another QR.');
    // (body() cambia los espacios irrompibles del francés por espacios normales.)
    expect(at(42, 'fr')).toContain('Il reste moins d’1 minute : 0:42. S’il expire, demandez un autre QR.');
    expect(at(42, 'pt')).toContain('Falta menos de 1 minuto: 0:42. Se expirar, peça outro QR.');
  });

  it('ámbar (--warn), 14 px y 600, con un reloj de trazo delante', () => {
    expect(SOON_CSS).toMatch(/\.soon\{color:var\(--warn\);[^}]*font-size:\.875rem;font-weight:600/);
    expect(SOON_CSS).toMatch(/\.soon::before\{[^}]*url\("data:image\/svg\+xml,[^"]*stroke='%23f5b342'[^"]*%3Ccircle cx='12' cy='12' r='9'\/%3E%3Cpath d='M12 7v5l3 2'\/%3E/);
    // El reloj va con el mismo ámbar que la ficha --warn.
    expect(CLUB_TOKENS).toContain('--warn:#f5b342');
    expect(CHOOSE_CSS).toContain(SOON_CSS);
  });

  it('con JS, cambia al llegar a los 60 s y el lector de pantalla lo oye una sola vez (#live)', () => {
    const html = at(298);
    expect(html).toContain('Queda menos de 1 minuto: {time}. Si caduca, pide otro QR.');
    expect(html).toContain(
      "if(s<=60){soon.textContent=T.soon.split('{time}').join(m);if(soon.hidden){soon.hidden=false;$('exp').hidden=true;if(live)live.textContent=soon.textContent;}}",
    );
  });
});

describe('cuando no cabe: lo que se aparta, por orden, para que el TOTAL quede por encima de la barra', () => {
  // Medido en 360×740 y en 390×844 (no cabe en ninguna de las dos): por eso van hasta 900 px de alto y no solo en las «bajas» (780).
  const FALLBACK = '@media (max-height:900px){';
  const fall = CHOOSE_CSS.slice(CHOOSE_CSS.indexOf(FALLBACK), CHOOSE_CSS.indexOf('\n}', CHOOSE_CSS.indexOf(FALLBACK)));
  const before = CHOOSE_CSS.slice(0, CHOOSE_CSS.indexOf(FALLBACK));
  const saldo = { payToken: 's', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), enabled: true };
  const page = (extra: Partial<PayablePayment>): string => {
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
    return renderChoosePage(view, { token: 't', lang: 'es', device: { wallet: 'Google Pay', inApp: null }, statementName: null, now: new Date(), suggest: 'en' });
  };

  it('1.º lo pedido, en una línea con «…»', () => {
    expect(fall).toContain('\n.concept{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
    // En pantallas altas sigue partiéndose en las líneas que haga falta.
    expect(before).not.toMatch(/\.concept\{[^}]*nowrap/);
  });

  it('2.º sin comisión ni propina marcada, sin desglose (el total ya es el importe grande); al elegir propina, vuelve', () => {
    expect(body({})).toContain('<dl class="brk nil" id="brk">');
    // Con comisión, o con una propina ya marcada, el desglose se ve siempre.
    expect(body({ serviceFeeCents: 330, serviceFeeBps: 1000 })).toContain('<dl class="brk" id="brk">');
    expect(body({ tipCents: 500, saldo })).toContain('<dl class="brk" id="brk">');
    expect(fall).toContain('\n.brk.nil{display:none}');
    // En pantallas altas el desglose sale como siempre.
    expect(before).not.toContain('.brk.nil');
    expect(body({})).toContain("var bk=$('brk');if(bk)bk.classList.toggle('nil',!(C.fee>0||s.tip>0));");
  });

  it('3.º la franja de idioma, debajo del formulario (antes del pie legal): en pantallas bajas, siempre', () => {
    expect(rule('body', true)).toBe('display:flex;flex-direction:column');
    expect(rule('.sug', true)).toBe('order:1');
    expect(rule('.legal-foot', true)).toBe('order:2');
    // En pantallas altas, arriba (donde se ve).
    expect(CHOOSE_CSS.slice(0, CHOOSE_CSS.indexOf('@media (max-height:780px){'))).not.toMatch(/\.sug\{order/);
    expect(fall).not.toContain('.sug{order');
  });

  it('y si ni así cabe (hay desglose a la vista al abrir): la franja baja también hasta 900 px de alto y las marcas siguen a la frase del banco en su línea', () => {
    expect(CROWDED_CSS).toBe(
      '@media (max-height:900px){body{display:flex;flex-direction:column}.sug{order:1}.legal-foot{order:2}.trust .marks{display:inline-flex;margin:0 0 0 .4rem;vertical-align:middle}}',
    );
    // Con comisión (o con una propina ya marcada) el desglose se ve: no cabe.
    expect(page({ serviceFeeCents: 330, serviceFeeBps: 1000 })).toContain(CROWDED_CSS);
    expect(page({ tipCents: 500, saldo })).toContain(CROWDED_CSS);
    // Sin comisión ni propina marcada (el desglose se aparta), las marcas siguen debajo de la frase.
    const light = page({});
    expect(light).toContain('<nav class="sug"');
    expect(light).not.toContain(CROWDED_CSS);
  });

  it('nunca se esconden la comisión, el total, el extracto, la caducidad ni la frase del banco', () => {
    const media = CHOOSE_CSS.slice(CHOOSE_CSS.indexOf('@media (max-height:780px){'));
    const hidden = [...`${media}${CROWDED_CSS}`.matchAll(/([^{}\n]+)\{[^{}]*display:none[^{}]*\}/g)].map((m) => m[1]!.trim());
    // Lo único que se quita: la «o» de adorno, dos detalles del botón de bitcoin y el desglose que no dice nada.
    expect(hidden).toEqual([
      '.paybar .or',
      '.paybar .alts:has(>.btn+.btn) .btn.btc .btcpre',
      '.paybar .alts:has(>.btn+.btn)+.btchint',
      '.brk.nil',
    ]);
    const html = body({ serviceFeeCents: 330, serviceFeeBps: 1000, qrExpiresAt: new Date(Date.now() + 30_000) });
    for (const piece of ['class="fee"', 'class="tot"', 'id="soon"', 'class="trust"', 'class="meta"']) expect(html).toContain(piece);
  });
});
