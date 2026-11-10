import { describe, expect, it } from 'vitest';
import { serviceFeeQuote, type VenueServiceFee } from '@nightpay/contracts';
import { TOPUP_JS, topUpCard } from './wallet-topup-view';
import { WALLET_TEXT } from './wallet-text';
import { SELF_TOPUP_MAX_CENTS, SELF_TOPUP_MIN_CENTS, topUpFeeTable } from './wallet-topup-rules';

/** «Recargar» en /w con la «Comisión del servicio»: el desglose Recarga 50 € · Comisión del servicio 6 € · Total a pagar 56 €. */

const base = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 };

/** Una función del JS de la página, tal cual (de una línea: `function nombre(...){...}`). */
function jsFunction(name: string): string {
  const found = TOPUP_JS.split('\n').find((line) => line.startsWith(`function ${name}(`));
  if (!found) throw new Error(`No está function ${name} en TOPUP_JS`);
  return found;
}

/**
 * El botón y el total del desglose, con el JS de verdad de la página: TU son
 * las opciones que manda el servidor; el importe sale como «EUR<céntimos>»
 * para comparar céntimos exactos.
 */
function pageSays(tu: Record<string, unknown>, cents: number): { label: string; total: number } {
  const run = new Function(
    'TU',
    'T',
    'c',
    `function fill(s,k,v){return s.split('{'+k+'}').join(v);}
function eurShort(x){return 'EUR'+x;}
function eurPay(x){return 'EUR'+x;}
${jsFunction('topOk')}
${jsFunction('topFee')}
${jsFunction('topLabel')}
return {label:topLabel(c),total:c+topFee(c)};`,
  ) as (tu: Record<string, unknown>, t: Record<string, string>, c: number) => { label: string; total: number };
  return run(tu, { topUp: 'Recargar', topUpGo: 'Recargar {amount}', topUpGoFee: 'Pagar {amount}' }, cents);
}

function optionsFor(fee: VenueServiceFee) {
  const bps = fee.enabled ? fee.topUpBps : null;
  return { ...base, minCents: SELF_TOPUP_MIN_CENTS, maxCents: SELF_TOPUP_MAX_CENTS, serviceFeeBps: bps, feesCents: topUpFeeTable(fee, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_MAX_CENTS) };
}

describe('/w «Recargar» con la comisión del servicio', () => {
  it('con comisión: el desglose (lo rellena el JS) y el aviso de que el saldo es la recarga', () => {
    const html = topUpCard('es', { ...base, serviceFeeBps: 1200, feesCents: null }).replace(/[\u00a0\u202f]/g, ' ');
    expect(html).toContain('id="topupFee"');
    expect(html).toContain('<dt>Recarga (a tu saldo)</dt><dd class="num" id="tbAmount"></dd>');
    expect(html).toContain('<dd class="num" id="tbFee"></dd>');
    expect(html).toContain('<dt>Total a pagar</dt><dd class="num" id="tbTotal"></dd>');
    // «¿Qué es?», con el % de las recargas: de la recarga (no «del consumo»), y que no va al saldo.
    expect(html).toContain('>¿Qué es?</button>');
    expect(html).toContain('Es un 12 % de la recarga, para la plataforma de pago. No va a tu saldo y no es una propina.');
    expect(html).not.toContain('del consumo');
    // Debajo del botón: lo que no gaste no se pierde, y la comisión no se devuelve.
    expect(html).toContain(WALLET_TEXT.es.topUpLeftoverFee);
    expect(html).toContain('La comisión del servicio no se devuelve.');
  });

  it('sin comisión: lo que no gaste no se pierde, sin hablar de comisión', () => {
    const html = topUpCard('es', { ...base, serviceFeeBps: null, feesCents: null });
    expect(html).not.toContain('id="topupFee"');
    expect(html).toContain(WALLET_TEXT.es.topUpLeftover);
    expect(html).not.toContain('comisión');
  });

  it('la comisión la manda el servidor ya calculada (M-3): el JS no la calcula', () => {
    expect(TOPUP_JS).not.toContain('Math.round');
    expect(TOPUP_JS).not.toContain('/10000');
    expect(jsFunction('topFee')).toContain('TU.feesCents');
    expect(TOPUP_JS).toContain("$('tbTotal').textContent=ok?eurPay(c+f):''");
  });

  it('con comisión, el botón dice lo que paga (el total), no solo lo que recarga', () => {
    expect(WALLET_TEXT.es.topUpGoFee).toBe('Pagar {amount}');
    expect(WALLET_TEXT.en.topUpGoFee).toBe('Pay {amount}');
    expect(WALLET_TEXT.fr.topUpGoFee).toBe('Payer {amount}');
    expect(WALLET_TEXT.pt.topUpGoFee).toBe('Pagar {amount}');
    const on = optionsFor({ enabled: true, cardBps: 1000, topUpBps: 1200 });
    expect(pageSays(on, 5000)).toEqual({ label: 'Pagar EUR5600', total: 5600 });
    // Sin comisión (o al 0 %), «Recargar 50 €»: es lo que paga.
    expect(pageSays(optionsFor({ enabled: false, cardBps: 1000, topUpBps: 1200 }), 5000)).toEqual({ label: 'Recargar EUR5000', total: 5000 });
    expect(pageSays(optionsFor({ enabled: true, cardBps: 1000, topUpBps: 0 }), 5000)).toEqual({ label: 'Recargar EUR5000', total: 5000 });
    // Un importe que no vale: sin cifra.
    expect(pageSays(on, 950).label).toBe('Recargar');
    expect(pageSays(on, 30100).label).toBe('Recargar');
    expect(pageSays(on, 5050).label).toBe('Recargar');
  });

  it('de 10 € a 300 € y con cualquier % (0 a 12 %): lo que dice el botón es lo que cobra el servidor', () => {
    let checked = 0;
    for (let bps = 0; bps <= 1200; bps += 1) {
      const fee = { enabled: true, cardBps: 1000, topUpBps: bps };
      const tu = optionsFor(fee);
      for (let cents = SELF_TOPUP_MIN_CENTS; cents <= SELF_TOPUP_MAX_CENTS; cents += 100) {
        // Lo que crea el servidor al recargar (PaymentsService: importe + comisión de la recarga).
        const server = serviceFeeQuote(fee, 'topUp', cents);
        const page = pageSays(tu, cents);
        if (page.total !== server.totalCents) throw new Error(`${bps} bps, ${cents} céntimos: la página ${page.total}, el servidor ${server.totalCents}`);
        const label = server.feeCents > 0 ? `Pagar EUR${server.totalCents}` : `Recargar EUR${cents}`;
        if (page.label !== label) throw new Error(`${bps} bps, ${cents} céntimos: «${page.label}» en vez de «${label}»`);
        checked += 1;
      }
    }
    expect(checked).toBe(1201 * 291);
  });
});
