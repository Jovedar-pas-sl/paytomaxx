import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from './customer-lang';
import { renderChooseBody } from './pay-choose-page';
import { PAY_TEXT } from './pay-i18n';
import { choosePayPage, type PayablePayment, type PayRedirect } from './pay-redirect';

/**
 * La página de pago (/pay) dice quién cobra (decisión del dueño, 19-11-2026):
 * su nombre visible y su foto si tiene, como /s. Nada más de esa persona.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

const PHOTO = 'data:image/webp;base64,UklGRg==';

function view(o: Partial<PayablePayment> = {}): ChooseView {
  return choosePayPage({
    id: '11111111-2222-4333-8444-555555555555',
    status: 'CREATED',
    amountCents: 2_000,
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
    venueName: 'Sala Aurora',
    ...o,
  }) as ChooseView;
}

const page = (v: ChooseView, lang: (typeof PAY_LANGUAGES)[number] = 'es') =>
  renderChooseBody(v, { token: 'tok-1', lang, device: { wallet: null, inApp: null }, statementName: null, now: new Date() });

describe('/pay dice quién cobra', () => {
  it('el nombre visible y la foto de quien hizo el cobro pasan a la página', () => {
    expect(view({ staffName: 'Ana', staffPhoto: PHOTO })).toMatchObject({ staffName: 'Ana', staffPhoto: PHOTO });
    expect(view()).not.toHaveProperty('staffName');
    expect(view()).not.toHaveProperty('staffPhoto');
  });

  it.each(PAY_LANGUAGES)('%s: «Te cobra Ana» con su foto, debajo del local y antes del importe', (lang) => {
    const html = page(view({ staffName: 'Ana', staffPhoto: PHOTO }), lang);
    const who = html.indexOf('<p class="who">');
    expect(who).toBeGreaterThan(html.indexOf('class="venue"'));
    expect(who).toBeLessThan(html.indexOf('id="big"'));
    expect(html).toContain(PAY_TEXT[lang].chargedBy('Ana'));
    // La foto es de adorno (el nombre va al lado): sin texto alternativo que repetir.
    expect(html).toContain(`<img class="face" src="${PHOTO}" alt="" width="32" height="32">`);
  });

  it('sin foto, solo el nombre; sin nombre (un reservado, el cliente desde casa), nada', () => {
    const html = page(view({ staffName: 'Ana' }));
    expect(html).toContain('<p class="who"><span>Te cobra Ana</span></p>');
    expect(html).not.toContain('class="face"');
    expect(page(view())).not.toContain('class="who"');
  });

  it('el nombre lo escribe la persona: se escapa; una foto que no es data:image no sale', () => {
    const html = page(view({ staffName: '<b>Ana</b>', staffPhoto: 'javascript:alert(1)' }));
    expect(html).toContain('Te cobra &lt;b&gt;Ana&lt;/b&gt;');
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).not.toContain('javascript:');
  });
});
