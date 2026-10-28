import { describe, expect, it } from 'vitest';
import { TOPUP_JS, topUpCard } from './wallet-topup-view';
import { WALLET_TEXT } from './wallet-text';

/** «Recargar» en /w con la «Comisión del servicio»: el desglose Recarga 50 € · Comisión del servicio 6 € · Total a pagar 56 €. */

const base = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 };

describe('/w «Recargar» con la comisión del servicio', () => {
  it('con comisión: el desglose (lo rellena el JS) y el aviso de que el saldo es la recarga', () => {
    const html = topUpCard('es', { ...base, serviceFeeBps: 1200 }).replace(/[\u00a0\u202f]/g, ' ');
    expect(html).toContain('id="topupFee"');
    expect(html).toContain('<dt>Recarga (a tu saldo)</dt><dd class="num" id="tbAmount"></dd>');
    expect(html).toContain('<dd class="num" id="tbFee"></dd>');
    expect(html).toContain('<dt>Total a pagar</dt><dd class="num" id="tbTotal"></dd>');
    // «¿Qué es?», con el % de las recargas.
    expect(html).toContain('>¿Qué es?</button>');
    expect(html).toContain('Es un 12 % del consumo que cobra la plataforma de pago por el servicio. No es una propina.');
    expect(html).toContain(WALLET_TEXT.es.topUpMethodsFee);
    expect(html).not.toContain(WALLET_TEXT.es.topUpMethods);
  });

  it('sin comisión: la de siempre', () => {
    const html = topUpCard('es', { ...base, serviceFeeBps: null });
    expect(html).not.toContain('id="topupFee"');
    expect(html).toContain(WALLET_TEXT.es.topUpMethods);
  });

  it('el JS calcula la comisión como el servidor (redondeo al céntimo) y escribe las tres cifras', () => {
    expect(TOPUP_JS).toContain('Math.round(c*bps/10000)');
    expect(TOPUP_JS).toContain("$('tbTotal').textContent=ok?eurShort(c+f):''");
    // El mismo cálculo que el JS: 50 € al 12 %.
    const topFee = new Function('TU', 'c', `${TOPUP_JS.match(/function topFee\(c\)\{[^}]*\}/)?.[0] ?? ''}; return topFee(c);`) as (
      tu: { serviceFeeBps: number },
      c: number,
    ) => number;
    expect(topFee({ serviceFeeBps: 1200 }, 5000)).toBe(600);
    expect(topFee({ serviceFeeBps: 0 }, 5000)).toBe(0);
  });
});
