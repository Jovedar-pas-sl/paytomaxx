import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES, type PayLanguage } from './customer-lang';
import { CHOOSE_CSS, renderChooseBody } from './pay-choose-page';
import { PAY_TEXT } from './pay-i18n';
import { BTC_IC } from './pay-marks';
import { choosePayPage, type PayRedirect } from './pay-redirect';

/**
 * «Pagar con bitcoin» en la página de pago (/pay/:token): su icono (el ₿ de
 * trazo, como la tarjeta), el texto y una línea corta de cuánto tarda cada
 * forma. Con los estilos de la página: un botón secundario más.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

function view(bitcoin: boolean): ChooseView {
  return choosePayPage({
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

const page = (bitcoin: boolean, lang: PayLanguage = 'es', wallet: 'Apple Pay' | null = 'Apple Pay') =>
  renderChooseBody(view(bitcoin), { token: 'tok-1', lang, device: { wallet, inApp: null }, statementName: null, now: new Date() });

/** El botón de bitcoin tal cual sale en la página. */
const button = (html: string): string => /<button[^>]*id="btcBtn"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';

describe('«Pagar con bitcoin» en la página de pago', () => {
  it('lleva su icono, el texto y la línea corta, y abre la página del QR (POST, el mismo formulario)', () => {
    const btn = button(page(true));
    expect(btn).toContain('formaction="/pay/tok-1/bitcoin?lang=es"');
    expect(btn).toContain('formmethod="post"');
    expect(btn).toContain(BTC_IC);
    expect(btn).toContain('>Pagar con bitcoin<');
    expect(btn).toContain('<small class="btchint">Lightning al momento · en la red, con 1 confirmación</small>');
    // Con las clases de la página: un botón secundario («alt»), como «Pagar con tarjeta».
    expect(btn).toMatch(/class="btn alt btc"/);
    // El ₿ suelto de antes ya no va: el icono es el de trazo.
    expect(btn).not.toContain('<span aria-hidden="true">₿</span>');
  });

  it.each(PAY_LANGUAGES)('en %s, con el texto y la línea corta de su idioma', (lang) => {
    const btn = button(page(true, lang));
    expect(btn).toContain(`?lang=${lang}`);
    expect(btn).toContain(PAY_TEXT[lang].payWithBitcoin);
    expect(PAY_TEXT[lang].bitcoinHint.length).toBeGreaterThan(10);
    expect(btn).toContain('btchint');
  });

  it('sin bitcoin en el local, no sale el botón', () => {
    expect(page(false)).not.toContain('id="btcBtn"');
    expect(page(false)).not.toContain('btchint');
  });

  it('también sin Apple Pay ni Google Pay (solo tarjeta y bitcoin)', () => {
    expect(button(page(true, 'en', null))).toContain('Lightning: instant · on-chain: 1 confirmation');
  });

  it('estilos de la página: la línea corta en pequeño y apagada; en pantallas bajas con los botones lado a lado, se esconde', () => {
    expect(CHOOSE_CSS).toContain('.btn.btc .btchint{font-size:.75rem;font-weight:400;line-height:1.25;color:var(--mute)}');
    const low = CHOOSE_CSS.slice(CHOOSE_CSS.indexOf('@media (max-height:780px){'));
    expect(low).toContain('.paybar .alts:has(>.btn+.btn) .btn.btc .btchint{display:none}');
  });
});
