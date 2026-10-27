import { describe, expect, it } from 'vitest';
import { choosePayPage, settledPayView, type PayablePayment, type PayRedirect } from './pay-redirect';
import { renderChoosePage, renderPaidPage, renderReceiptPage } from './public-pay.pages';

/**
 * Lo que ve el cliente con la «Comisión del servicio»: el desglose antes de
 * pagar (Consumo · Comisión del servicio · Propina · Total), el «Pagado» y el
 * justificante con su línea. Sin comisión, la página de siempre.
 */

const sp = (s: string): string => s.replace(/\u00a0/g, ' ');

function payable(extra: Partial<PayablePayment> = {}): PayablePayment {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    status: 'CREATED',
    amountCents: 3300,
    tipCents: 0,
    currency: 'EUR',
    qrExpiresAt: new Date(Date.now() + 5 * 60_000),
    authorizedAt: null,
    allowTip: true,
    walletToken: null,
    walletClaimHash: null,
    walletCode: null,
    walletHasFaceId: false,
    walletHasPin: false,
    ...extra,
  };
}

const ctx = { token: 'tok', lang: 'es' as const, device: { wallet: null, inApp: null }, statementName: null, now: new Date() };

function choose(extra: Partial<PayablePayment> = {}): Extract<PayRedirect, { kind: 'choose' }> {
  const view = choosePayPage(payable(extra));
  if (view.kind !== 'choose') throw new Error('no es la página de pago');
  return view;
}

describe('página de pago (/pay) con la comisión del servicio', () => {
  it('enseña Consumo 33 € · Comisión del servicio 3,30 € · Propina · Total 36,30 € y el botón con el total', () => {
    const html = sp(renderChoosePage(choose({ serviceFeeCents: 330, serviceFeeBps: 1000 }), ctx));
    expect(html).toContain('<dt>Consumo</dt><dd class="num">33 €</dd>');
    expect(html).toMatch(/<dt>Comisión del servicio <button class="why"[^>]*>¿Qué es\?<\/button><\/dt><dd class="num">3,30 €<\/dd>/);
    // «¿Qué es?»: corta y con su %; sin JS se ve, con JS se pliega.
    expect(html).toContain('<dd class="whytext" id="feeWhy">Es un 10 % del consumo que cobra la plataforma de pago por el servicio. No es una propina.</dd>');
    expect(html).toContain('<div id="brkTip"><dt>Propina</dt><dd class="num" id="brkTipV">0 €</dd></div>');
    expect(html).toContain('<dd class="num" id="total">36,30 €</dd>');
    // Al elegir la propina, el lector de pantalla oye solo el total (una sola región viva).
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toContain('<p class="sr" id="live" aria-live="polite" aria-atomic="true"></p>');
    expect(html).toContain('<dl class="brk" id="brk">');
    expect(html).toContain('Pagar 36,30 €</button>');
    // Arriba, grande, lo que paga (también se pone al día con la propina).
    expect(html).toContain('<span id="big">36,30 €</span>');
    // El JS suma la comisión: 33 + 3,30 + la propina elegida.
    expect(html).toContain('npPayTotal(C.amount,C.fee,s.tip)');
    expect(html).toMatch(/fee\\?":330/);
  });

  it('una recarga dice «Recarga» (50 € + 6 € = 56 €)', () => {
    const html = sp(renderChoosePage(choose({ amountCents: 5000, serviceFeeCents: 600, topUp: true, allowTip: false }), ctx));
    expect(html).toContain('<dt>Recarga</dt><dd class="num">50 €</dd>');
    expect(html).toMatch(/<dt>Comisión del servicio<\/dt><dd class="num">6 €<\/dd>/);
    expect(html).not.toContain('id="brkTip"');
    expect(html).toContain('Pagar 56 €</button>');
  });

  it('cobro único: con el saldo, sin comisión del servicio', () => {
    const view = choose({ serviceFeeCents: 330, saldo: { payToken: 'stok', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), enabled: true } });
    const html = sp(renderChoosePage(view, ctx));
    expect(html).toContain('>Pagar con mi saldo</a>');
    expect(html).toContain('Con tu saldo, sin comisión del servicio.');
  });

  it('sin comisión: sin su línea; el desglose con la propina y el total del importe', () => {
    const html = sp(renderChoosePage(choose(), ctx));
    expect(html).not.toContain('Comisión del servicio');
    expect(html).toContain('<dd class="num" id="total">33 €</dd>');
    expect(html).toContain('Pagar 33 €</button>');
    // Sin comisión ni propinas, ni desglose: el importe de arriba lo dice todo.
    expect(sp(renderChoosePage(choose({ allowTip: false }), ctx))).not.toContain('class="brk"');
  });
});

describe('«Pagado» y justificante', () => {
  it('el «Pagado» suma la comisión y lo dice (38,30 € con 3,30 € de comisión y 2 € de propina)', () => {
    const settled = settledPayView(payable({ status: 'AUTHORIZED', tipCents: 200, serviceFeeCents: 330, authorizedAt: new Date() }));
    expect(settled).toMatchObject({ kind: 'paid', serviceFeeCents: 330 });
    const html = sp(
      renderPaidPage(
        { amountCents: 3300, tipCents: 200, serviceFeeCents: 330, currency: 'EUR', code: 'ABC', authorizedAt: new Date(), receiptHref: null },
        'es',
      ),
    );
    expect(html).toContain('<p class="pamount num" data-amount>38,30 €</p>');
    expect(html).toContain('<div><dt>Consumo</dt><dd class="num">33 €</dd></div>');
    expect(html).toContain('<div><dt>Comisión del servicio</dt><dd class="num">3,30 €</dd></div>');
    expect(html).toContain('<div><dt>Propina</dt><dd class="num">2 €</dd></div>');
    expect(html).toContain('¡Gracias por la propina!');
  });

  it('el justificante lleva la línea «Comisión del servicio» y el total con ella', () => {
    const html = sp(
      renderReceiptPage(
        {
          paymentId: '11111111-2222-4333-8444-555555555555',
          amountCents: 3300,
          tipCents: 200,
          serviceFeeCents: 330,
          currency: 'EUR',
          authorizedAt: null,
          authCode: null,
          cardBrand: null,
          payMethod: 'card',
          order: null,
        },
        { lang: 'es', statementName: null, backHref: '/pay/tok' },
      ),
    );
    expect(html).toContain('<dt>Importe</dt><dd>33,00 €</dd>');
    expect(html).toContain('<dt>Comisión del servicio</dt><dd>3,30 €</dd>');
    expect(html).toContain('<dt>Propina</dt><dd>2,00 €</dd>');
    expect(html).toContain('<dt>Total cobrado</dt><dd>38,30 €</dd>');
  });

  it('en inglés, francés y portugués: «Service fee», «Frais de service», «Taxa de serviço» (con su explicación)', () => {
    const view = choose({ serviceFeeCents: 330, serviceFeeBps: 1000 });
    const en = sp(renderChoosePage(view, { ...ctx, lang: 'en' }));
    expect(en).toContain('<dt>Service fee <button');
    expect(en).toContain('A 10% fee on your order');
    expect(en).toContain('Pay €36.30</button>');
    const fr = sp(renderChoosePage(view, { ...ctx, lang: 'fr' }));
    expect(fr).toContain('<dt>Frais de service <button');
    expect(fr).toContain('Des frais de 10 % sur votre consommation');
    expect(fr).toContain('Payer 36,30 €</button>');
    const pt = sp(renderChoosePage(view, { ...ctx, lang: 'pt' }));
    expect(pt).toContain('<dt>Taxa de serviço <button');
    expect(pt).toContain('É uma taxa de 10% sobre o consumo');
    expect(pt).toContain('Pagar 36,30 €</button>');
  });
});
