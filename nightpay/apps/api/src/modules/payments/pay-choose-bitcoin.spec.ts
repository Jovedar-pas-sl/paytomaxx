import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES, type PayLanguage } from './customer-lang';
import { CHOOSE_CSS, renderChooseBody } from './pay-choose-page';
import { PAY_TEXT } from './pay-i18n';
import { BTC_MARK } from './pay-marks';
import { choosePayPage, type PayRedirect } from './pay-redirect';

/**
 * «Pagar con bitcoin» en la página de pago (/pay/:token): un botón blanco al
 * estilo del de Apple Pay («Pagar con» + el logo naranja de bitcoin + «bitcoin»),
 * y debajo una línea corta de cuánto tarda cada forma.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

function view(bitcoin: boolean, topUp = false): ChooseView {
  return choosePayPage({
    ...(topUp ? { topUp: true } : {}),
    id: '11111111-2222-4333-8444-555555555555',
    status: 'CREATED',
    amountCents: 100,
    serviceFeeCents: 10,
    serviceFeeBps: 1000,
    tipCents: 0,
    currency: 'EUR',
    qrExpiresAt: new Date(Date.now() + 300_000),
    authorizedAt: null,
    allowTip: false,
    walletToken: null,
    walletClaimHash: null,
    walletCode: null,
    walletHasFaceId: false,
    walletHasPin: false,
    ...(bitcoin ? { bitcoin: true } : {}),
  }) as ChooseView;
}

const page = (bitcoin: boolean, lang: PayLanguage = 'es', wallet: 'Apple Pay' | null = 'Apple Pay', topUp = false) =>
  renderChooseBody(view(bitcoin, topUp), { token: 'tok-1', lang, device: { wallet, inApp: null }, statementName: null, now: new Date() });

/** El botón de bitcoin tal cual sale en la página. */
const button = (html: string): string => /<button[^>]*id="btcBtn"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';

describe('«Pagar con bitcoin» en la página de pago', () => {
  it('al estilo de Apple Pay: «Pagar con» + el logo + «bitcoin», y abre la página del QR (POST, el mismo formulario)', () => {
    const html = page(true);
    const btn = button(html);
    expect(btn).toContain('formaction="/pay/tok-1/bitcoin?lang=es"');
    expect(btn).toContain('formmethod="post"');
    expect(btn).toContain(BTC_MARK);
    expect(btn).toContain('aria-label="Pagar con bitcoin"');
    expect(btn).toContain('<span class="btcpre">Pagar con</span>');
    expect(btn).toContain('<span class="btcword">bitcoin</span>');
    // Botón propio (blanco, como Apple Pay en esta página oscura), no el secundario «alt».
    expect(btn).toMatch(/class="btn btc"/);
    // La línea corta va debajo de los botones, no dentro.
    expect(btn).not.toContain('btchint');
    expect(html).toContain('<p class="btchint">Lightning al momento · en la red, con 1 confirmación</p>');
  });

  it.each(PAY_LANGUAGES)('en %s, con el texto y la línea corta de su idioma', (lang) => {
    const html = page(true, lang);
    const btn = button(html);
    expect(btn).toContain(`?lang=${lang}`);
    expect(btn).toContain(`aria-label="${PAY_TEXT[lang].payWithBitcoin}"`);
    expect(PAY_TEXT[lang].payWithBitcoin.startsWith(PAY_TEXT[lang].payWithBitcoinPrefix)).toBe(true);
    expect(btn).toContain(`>${PAY_TEXT[lang].payWithBitcoinPrefix}<`);
    expect(PAY_TEXT[lang].bitcoinHint.length).toBeGreaterThan(10);
    expect(html).toContain('class="btchint"');
  });

  it('en una carga de saldo y en la página de pago de un reservado (también recargas): el mismo botón, igual que en todas', () => {
    const carga = page(true, 'es', 'Apple Pay', true);
    expect(carga).toContain('Recarga');
    expect(button(carga)).toBe(button(page(true)));
    expect(button(carga)).toContain(BTC_MARK);
  });

  it('sin bitcoin en el local, no sale el botón', () => {
    expect(page(false)).not.toContain('id="btcBtn"');
    expect(page(false)).not.toContain('btchint');
  });

  it('también sin Apple Pay ni Google Pay (solo tarjeta y bitcoin)', () => {
    expect(page(true, 'en', null)).toContain('Lightning: instant · on-chain: 1 confirmation');
  });

  it('estilos: blanco con el logo como Apple Pay; en pantallas bajas con los botones lado a lado, solo logo + «bitcoin» y sin la línea corta', () => {
    expect(CHOOSE_CSS).toContain('.btn.btc{background:#fff;border-color:#fff;color:#000;');
    expect(CHOOSE_CSS).toContain('.btchint{font-size:.75rem;line-height:1.3;color:var(--mute)}');
    const low = CHOOSE_CSS.slice(CHOOSE_CSS.indexOf('@media (max-height:780px){'));
    expect(low).toContain('.paybar .alts:has(>.btn+.btn) .btn.btc .btcpre{display:none}');
    expect(low).toContain('.paybar .alts:has(>.btn+.btn)+.btchint{display:none}');
  });
});
