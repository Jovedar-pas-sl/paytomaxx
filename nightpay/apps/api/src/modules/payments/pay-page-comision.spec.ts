import { describe, expect, it } from 'vitest';
import { choosePayPage, settledPayView, type PayablePayment, type PayRedirect } from './pay-redirect';
import { renderChoosePage, renderPaidPage, renderReceiptPage } from './public-pay.pages';

/**
 * Lo que ve el cliente con la «Comisión del servicio»: el desglose antes de
 * pagar (Consumo · Comisión del servicio · Propina · Total), el «Pagado» y el
 * justificante con su línea. Sin comisión, la página de siempre.
 */

const sp = (s: string): string => s.replace(/ /g, ' ');

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
  it('enseña Consumo 33 € · Comisión del servicio 3,30 € · Total 36,30 € y el botón con el total', () => {
    const html = sp(renderChoosePage(choose({ serviceFeeCents: 330 }), ctx));
    expect(html).toContain('<dt>Consumo</dt><dd class="num">33 €</dd>');
    expect(html).toContain('<dt>Comisión del servicio</dt><dd class="num">3,30 €</dd>');
    expect(html).toContain('id="brkTip" hidden><dt>Propina</dt>');
    expect(html).toContain('id="total">36,30 €</dd>');
    expect(html).toContain('Pagar 36,30 €</button>');
    // El JS suma la comisión: 33 + 3,30 + la propina elegida.
    expect(html).toContain('C.amount+(C.fee||0)+tp');
    expect(html).toMatch(/fee\\?":330/);
  });

  it('una recarga dice «Recarga» (50 € + 6 € = 56 €)', () => {
    const html = sp(renderChoosePage(choose({ amountCents: 5000, serviceFeeCents: 600, topUp: true, allowTip: false }), ctx));
    expect(html).toContain('<dt>Recarga</dt><dd class="num">50 €</dd>');
    expect(html).toContain('<dt>Comisión del servicio</dt><dd class="num">6 €</dd>');
    expect(html).toContain('Pagar 56 €</button>');
  });

  it('cobro único: con el saldo, sin comisión del servicio', () => {
    const view = choose({ serviceFeeCents: 330, saldo: { payToken: 'stok', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), enabled: true } });
    const html = sp(renderChoosePage(view, ctx));
    expect(html).toContain('Pagar con mi saldo OxioCard');
    expect(html).toContain('Con tu saldo OxioCard, sin comisión del servicio.');
  });

  it('sin comisión: la de siempre (sin desglose, total del importe)', () => {
    const html = sp(renderChoosePage(choose(), ctx));
    expect(html).not.toContain('Comisión del servicio');
    expect(html).not.toContain('class="brk"');
    expect(html).toContain('Pagar 33 €</button>');
    expect(html).toContain('id="total">33 €</b>');
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
    expect(html).toContain('38,30 €');
    expect(html).toContain('Incluye 3,30 € de comisión del servicio.');
    expect(html).toContain('Incluye 2 € de propina');
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

  it('en inglés: «Service fee»', () => {
    const html = sp(renderChoosePage(choose({ serviceFeeCents: 330 }), { ...ctx, lang: 'en' }));
    expect(html).toContain('<dt>Service fee</dt>');
  });
});
