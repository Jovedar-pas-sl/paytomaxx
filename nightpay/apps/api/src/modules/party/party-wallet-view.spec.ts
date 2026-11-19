import { describe, it, expect } from 'vitest';
import { renderWalletPage } from '../wallets/wallet-page';
import type { ClientWalletState } from '../wallets/wallet-charges.service';
import type { PartyPageData } from './party-refunds.service';
import { PARTY_CSS, PARTY_JS, PARTY_THEME_COLOR } from './party-wallet-view';
import { PARTY_WALLET_TEXT } from './party-wallet-text';

function state(o: Partial<ClientWalletState> = {}): ClientWalletState {
  return {
    code: 'K7Q-4M2',
    balanceCents: 1300,
    status: 'ACTIVE',
    closeRequested: false,
    hasFaceId: false,
    hasPin: true,
    hasCard: true,
    fichaNumber: '0412',
    venueName: 'Fiestas de San Juan',
    merged: false,
    refund: null,
    cards: ['4242'],
    pulsera: 'P-0412',
    movements: [
      { kind: 'consumption', amountCents: -700, label: '2 cañas', venueName: 'Fiestas de San Juan', at: '2027-06-24T23:42:00.000Z', ref: 'C-0007', color: '#c7d301', stallName: 'Peña El Cántaro' },
    ],
    ...o,
  };
}

const party: PartyPageData = {
  brand: 'OxioParty',
  venueName: 'Fiestas de San Juan',
  eventStartsAt: '2027-06-23T18:00:00.000Z',
  eventEndsAt: '2027-06-25T04:00:00.000Z',
  refund: {
    deadline: '2027-06-30',
    open: true,
    allowDonation: true,
    balanceCents: 1300,
    available: { CARD: 800, TRANSFER: 500, DONATE: 1300 },
    faceId: true,
    locked: false,
    requests: [],
  },
};

const script = (html: string): string => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
const BACKSLASH = String.fromCharCode(92);

/** Contraste WCAG entre dos colores #RRGGBB. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe('página de la pulsera (OxioParty)', () => {
  it('de día, con la marca, la fiesta, los tres botones, las hojas y el plazo', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { party });
    expect(html).toContain(`<meta name="theme-color" content="${PARTY_THEME_COLOR}">`);
    expect(html).toContain(PARTY_CSS);
    expect(html).toContain('<p class="pbrand">OxioParty<i aria-hidden="true"></i></p>');
    expect(html).toContain('<span class="pchip">Fiestas de San Juan</span>');
    expect(html).toContain('id="pTop"');
    expect(html).toContain('>Recargar</span>');
    expect(html).toContain('>Lo que sobra</span>');
    expect(html).toContain('>La perdí</span>');
    expect(html).toContain('id="sobraSheet"');
    expect(html).toContain('id="pLostSheet"');
    expect(html).toContain('<p class="pnote" id="pNote"></p>');
    // El selector de idioma sigue arriba.
    expect(html).toContain('<details class="lang" id="langMenu">');
    // Nunca «chica» en lo que añade OxioParty.
    expect(`${JSON.stringify(PARTY_WALLET_TEXT)}${PARTY_JS}`.toLowerCase()).not.toContain('chica');
  });

  it('el JS: la caseta en los movimientos, «Lo que sobra» y la pulsera en el saldo; sin barras invertidas', () => {
    const js = script(renderWalletPage('tok-1', 'es', state(), { party }));
    expect(js).toContain('mvText(m,a,sub);');
    expect(js).toContain('partyRender(s);');
    expect(js).toContain("withKey('/sobra',body)");
    expect(PARTY_JS).not.toContain(BACKSLASH);
    expect(() => new Function(js)).not.toThrow();
  });

  it('cada $(id) del JS de la pulsera está en la página (uno que falte rompe partyRender)', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { party });
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...PARTY_JS.matchAll(/\$\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('sin la regla de OxioPay («el saldo no se devuelve»): en la fiesta lo que sobra se pide', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { party });
    expect(html).toContain('id="keepRule"');
    expect(PARTY_CSS).toContain('#keepRule,#topupRule{display:none}');
  });

  it('en los cuatro idiomas el JS se lee y lleva sus textos', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const html = renderWalletPage('tok-1', lang, state(), { party });
      expect(() => new Function(script(html))).not.toThrow();
      expect(html).toContain(`<span>${PARTY_WALLET_TEXT[lang].sobra}</span>`);
    }
  });

  it('con OxioPay (sin party) la página es la de siempre', () => {
    const club = renderWalletPage('tok-1', 'es', state());
    expect(renderWalletPage('tok-1', 'es', state(), { party: null })).toBe(club);
    expect(club).toContain('<meta name="theme-color" content="#0b0d0e">');
    for (const mark of ['pSobra', 'mvText', 'partyRender', 'sobraSheet', 'pbrand', '"party"']) expect(club).not.toContain(mark);
  });

  it('contraste de 4,5:1 o más en el texto de día', () => {
    const tokens = Object.fromEntries([...PARTY_CSS.matchAll(/--([a-z0-9-]+):(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
    expect(contrast(tokens.fg!, tokens.bg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.mute!, tokens.bg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.dim!, tokens.bg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.dim!, tokens.surface!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.ok!, tokens.surface!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.err!, '#FFF4F0')).toBeGreaterThanOrEqual(4.5);
    // El saldo y el botón principal: lima sobre tinta; lo de la tarjeta oscura, claro sobre tinta.
    expect(contrast('#C7D301', tokens.night!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['night-2']!, tokens.night!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('el JS de la pulsera', () => {
  const fn = <T>(name: string, until: string, args: string[] = []): T => {
    const src = PARTY_JS.slice(PARTY_JS.indexOf(`function ${name}(`), PARTY_JS.indexOf(`function ${until}(`));
    return new Function(...args, `${src}return ${name};`)(...args.map(() => undefined)) as T;
  };

  it('el IBAN con su dígito de control (mod-97), como el servidor', () => {
    const ibanOk = fn<(v: string) => boolean>('ibanOk', 'mvText');
    expect(ibanOk('ES9121000418450200051332')).toBe(true);
    expect(ibanOk('DE89370400440532013000')).toBe(true);
    expect(ibanOk('ES9121000418450200051333')).toBe(false);
    expect(ibanOk('ES91')).toBe(false);
  });

  it('«Lo que sobra» sin Face ID: solo a la tarjeta; transferencia y donar, con Face ID', () => {
    const src = PARTY_JS.slice(PARTY_JS.indexOf('function sbOk('), PARTY_JS.indexOf('function sbMark('));
    const ways = (faceId: boolean, available: Record<string, number>) =>
      (new Function('P', `${src}return sbAvail;`)({ refund: { faceId, available } }) as () => string[])();
    expect(ways(false, { CARD: 800, TRANSFER: 500, DONATE: 1300 })).toEqual(['CARD']);
    expect(ways(true, { CARD: 800, TRANSFER: 500, DONATE: 1300 })).toEqual(['CARD', 'TRANSFER', 'DONATE']);
    expect(ways(false, { CARD: 0, TRANSFER: 500, DONATE: 500 })).toEqual([]);
    // Y la página lo dice en claro (el texto va en la hoja; el JS lo enseña).
    const html = renderWalletPage('tok', 'es', state(), { party });
    expect(html).toContain('<p class="sbwhy" id="sobraFace" hidden>Para transferencia o donar, activa Face ID o pásate por la taquilla.</p>');
    expect(PARTY_JS).toContain("$('sobraFace').hidden=!face");
  });

  it('cada movimiento con la caseta delante y lo pedido debajo; sin caseta, como siempre', () => {
    const src = PARTY_JS.slice(PARTY_JS.indexOf('function mvText('), PARTY_JS.indexOf('function pReq('));
    const T = { mv: { topUpCash: 'Recarga en efectivo' }, detail: { returned: 'Devuelto a tu saldo' } };
    const when = () => '01:42';
    const mvText = new Function('T', 'when', `${src}return mvText;`)(T, when) as (m: object, a: { textContent: string }, s: { textContent: string }) => void;
    const a = { textContent: '' };
    const sub = { textContent: '' };
    mvText({ label: '2 cañas', stallName: 'Peña El Cántaro', ref: null, at: 'x' }, a, sub);
    expect([a.textContent, sub.textContent]).toEqual(['Peña El Cántaro', '2 cañas · 01:42']);
    mvText({ label: 'Recarga en efectivo', labelKey: 'topUpCash', ref: null, at: 'x' }, a, sub);
    expect([a.textContent, sub.textContent]).toEqual(['Recarga en efectivo', '01:42']);
    mvText({ label: '1 agua', stallName: 'Barra', returned: true, ref: 'C-0002', at: 'x' }, a, sub);
    expect(sub.textContent).toBe('Devuelto a tu saldo · 1 agua · C-0002 · 01:42');
  });
});
