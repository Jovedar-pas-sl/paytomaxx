import { describe, expect, it } from 'vitest';
import { MONEY_JS, clientMoney } from './club-ui';
import { PAY_LANGUAGES, languageLocale } from './customer-lang';
import { TIP_JS, renderChooseBody } from './pay-choose-page';
import { choosePayPage, type PayablePayment, type PayRedirect } from './pay-redirect';
import { MAX_TIP_CENTS, maxTipCents, tipChoiceAllowed } from './tip';

/**
 * La propina en la página de pago: «Otra» (euros enteros, con su error dicho
 * con palabras) y el total que se enseña, con el JS de verdad de la página.
 * Lo que manda el navegador lo vuelve a comprobar el API (tipChoiceAllowed):
 * aquí se prueba que la página nunca deja enviar algo que el API rechazaría.
 */

const js = new Function(`${TIP_JS}; return { npTipOther, npPayTotal };`)() as {
  npTipOther: (raw: unknown, max: number) => { cents: number; error: 'empty' | 'max' | null };
  npPayTotal: (amount: number, fee: number, tip: number) => number;
};
const npMoney = new Function(`${MONEY_JS}; return npMoney;`)() as (c: number, l: string, cur: string) => string;

describe('«Otra» propina', () => {
  it('euros enteros con el teclado numérico; lo que no son cifras no cuenta', () => {
    expect(js.npTipOther('4', 3300)).toEqual({ cents: 400, error: null });
    expect(js.npTipOther(' 12 ', 3300)).toEqual({ cents: 1200, error: null });
    expect(js.npTipOther('1.5', 3300)).toEqual({ cents: 1500, error: null });
    expect(js.npTipOther('3€', 3300)).toEqual({ cents: 300, error: null });
  });

  it('sin importe (o 0): error «escribe cuánto», no se manda una propina de 0 € con «Otra» marcada', () => {
    expect(js.npTipOther('', 3300)).toEqual({ cents: 0, error: 'empty' });
    expect(js.npTipOther('0', 3300)).toEqual({ cents: 0, error: 'empty' });
    expect(js.npTipOther('abc', 3300)).toEqual({ cents: 0, error: 'empty' });
    expect(js.npTipOther(null, 3300)).toEqual({ cents: 0, error: 'empty' });
  });

  it('el tope de siempre: como mucho el importe del cobro y nunca más de 500 €; por encima, error (no se recorta a escondidas)', () => {
    expect(js.npTipOther('33', maxTipCents(3300))).toEqual({ cents: 3300, error: null });
    expect(js.npTipOther('34', maxTipCents(3300))).toEqual({ cents: 0, error: 'max' });
    expect(js.npTipOther('500', maxTipCents(90_000))).toEqual({ cents: 50_000, error: null });
    expect(js.npTipOther('501', maxTipCents(90_000))).toEqual({ cents: 0, error: 'max' });
    expect(MAX_TIP_CENTS).toBe(50_000);
  });

  it('todo lo que la página deja enviar lo acepta el API', () => {
    for (const amount of [400, 1250, 3300, 4100, 90_000]) {
      const max = maxTipCents(amount);
      for (const raw of ['1', '2', '5', '10', '33', '40', '499', '500']) {
        const r = js.npTipOther(raw, max);
        if (r.error === null) expect(tipChoiceAllowed({ amountCents: amount, tipCents: 0, allowTip: true }, r.cents)).toBe(true);
      }
    }
  });
});

describe('el total que se enseña', () => {
  it('importe + comisión del servicio + propina (la misma cuenta que el API)', () => {
    expect(js.npPayTotal(3300, 330, 200)).toBe(3830);
    expect(js.npPayTotal(3300, 0, 0)).toBe(3300);
    expect(js.npPayTotal(3300, undefined as unknown as number, 500)).toBe(3800);
  });

  it.each(PAY_LANGUAGES)('%s: el JS formatea igual que el servidor (euros, con o sin céntimos)', (lang) => {
    const locale = languageLocale(lang);
    for (const c of [0, 200, 3300, 3830, 110_950, -1200]) expect(npMoney(c, locale, 'EUR')).toBe(clientMoney(c, locale));
  });

  it('formato de cada idioma, siempre en euros', () => {
    const sp = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');
    expect(sp(clientMoney(3830, 'es-ES'))).toBe('38,30 €');
    expect(sp(clientMoney(3300, 'es-ES'))).toBe('33 €');
    expect(sp(clientMoney(110_950, 'es-ES'))).toBe('1.109,50 €');
    expect(clientMoney(3830, 'en-GB')).toBe('€38.30');
    expect(clientMoney(110_900, 'en-GB')).toBe('€1,109');
    expect(sp(clientMoney(3830, 'fr-FR'))).toBe('38,30 €');
    expect(sp(clientMoney(110_900, 'fr-FR'))).toBe('1 109 €');
    expect(sp(clientMoney(3830, 'pt-PT'))).toBe('38,30 €');
    expect(sp(clientMoney(110_900, 'pt-PT'))).toBe('1 109 €');
  });
});

describe('estado de la propina en la página', () => {
  const payable = (extra: Partial<PayablePayment> = {}): PayablePayment => ({
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
  });
  const ctx = { token: 'tok', lang: 'es' as const, device: { wallet: 'Apple Pay' as const, inApp: null }, statementName: null, now: new Date() };
  const render = (extra: Partial<PayablePayment> = {}): string => {
    const view = choosePayPage(payable(extra)) as Extract<PayRedirect, { kind: 'choose' }>;
    return renderChooseBody(view, ctx).replace(/[\u00a0\u202f]/g, ' ');
  };

  it('«Sin propina» marcada por defecto, las sugeridas de siempre y «Otra» (oculta hasta que hay JS)', () => {
    const html = render();
    expect(html).toContain('<input type="radio" name="tip" value="0" checked><span class="word">Sin propina</span>');
    expect(html).toContain('value="200"><span class="num">+2 €</span>');
    expect(html).toContain('value="500"><span class="num">+5 €</span>');
    expect(html).toContain('<label id="otherOpt" hidden>');
    expect(html).toContain('inputmode="numeric"');
    expect(html).toContain('Como mucho 33 €');
  });

  it('por encima de 40 €: 10 % y 15 % con su importe en euros enteros', () => {
    const html = render({ amountCents: 6000 });
    expect(html).toMatch(/value="600"><span class="num">10 ?%<small class="num">\+6 €<\/small>/);
    expect(html).toMatch(/value="900"><span class="num">15 ?%<small class="num">\+9 €<\/small>/);
  });

  it('el desglose y el total arrancan con la propina ya marcada (cobro único con la propina pedida)', () => {
    const html = render({
      tipCents: 200,
      serviceFeeCents: 330,
      serviceFeeBps: 1000,
      saldo: { payToken: 's', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), enabled: true },
    });
    expect(html).toContain('value="200" checked>');
    expect(html).toContain('<dd class="num" id="brkTipV">2 €</dd>');
    expect(html).toContain('<dd class="num" id="total">38,30 €</dd>');
    expect(html).toContain('<span id="big">38,30 €</span>');
    expect(html).toContain('Pagar 38,30 €</button>');
  });
});
