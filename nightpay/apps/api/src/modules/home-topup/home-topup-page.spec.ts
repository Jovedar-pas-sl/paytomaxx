import { describe, expect, it } from 'vitest';
import { serviceFeeBpsFor, serviceFeeQuote, type VenueServiceFee } from '@nightpay/contracts';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { SELF_TOPUP_MAX_CENTS, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_PRESETS_CENTS, topUpFeeTable } from '../wallets/wallet-topup-rules';
import { HOME_JS, renderHomeTopUpGone, renderHomeTopUpPage } from './home-topup-page';
import { HOME_TOPUP_TEXT } from './home-topup-text';
import { WALLET_TEXT } from '../wallets/wallet-text';
import type { HomeTopUpPageView } from './home-topup.service';

const CODE = 'AbCdEfGhIjKlMnOp';

function viewFor(fee: VenueServiceFee | null, extra: Partial<HomeTopUpPageView> = {}): HomeTopUpPageView {
  return {
    venueName: 'Sala Aurora',
    problem: null,
    presetsCents: [...SELF_TOPUP_PRESETS_CENTS],
    minCents: SELF_TOPUP_MIN_CENTS,
    maxCents: SELF_TOPUP_MAX_CENTS,
    serviceFeeBps: fee ? serviceFeeBpsFor(fee, 'topUp') : null,
    feesCents: fee ? topUpFeeTable(fee, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_MAX_CENTS) : null,
    mine: null,
    ...extra,
  };
}

/** Lo que va dentro de los <script> de la página. */
function scripts(html: string): string {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').join('\n');
}

/** Una función del JS de la página tal cual (una línea: `function nombre(...){...}`). */
function jsFunction(name: string): string {
  const found = HOME_JS.split('\n').find((line) => line.startsWith(`function ${name}(`));
  if (!found) throw new Error(`No está function ${name} en HOME_JS`);
  return found;
}

/** El botón y el total con el JS de verdad de la página (el importe sale como «EUR<céntimos>»). */
function pageSays(view: HomeTopUpPageView, cents: number): { label: string; total: number } {
  const run = new Function(
    'C',
    'T',
    'c',
    `function fill(s,k,v){return s.split('{'+k+'}').join(v);}
function eur(x){return 'EUR'+x;}
function eurP(x){return 'EUR'+x;}
${jsFunction('ok')}
${jsFunction('fee')}
${jsFunction('label')}
return {label:label(c),total:c+fee(c)};`,
  ) as (cfg: Record<string, unknown>, t: Record<string, string>, c: number) => { label: string; total: number };
  return run({ min: view.minCents, max: view.maxCents, fees: view.feesCents }, { go: 'Cargar {amount}', goFee: 'Pagar {amount}', goPlain: 'Cargar saldo' }, cents);
}

describe('la página del enlace del local (/r/<código>)', () => {
  it.each(PAY_LANGUAGES)('%s: el local, cuánto, el total, las condiciones y el botón hacia el pago', (lang) => {
    const html = renderHomeTopUpPage(CODE, lang, viewFor({ enabled: true, cardBps: 1000, topUpBps: 1200 }));
    const t = HOME_TOPUP_TEXT[lang];
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain('<span>Sala Aurora</span>');
    expect(html).toContain(t.noExpiry.replace(/'/g, '&#39;'));
    expect(html).toContain('id="brk"');
    expect(html).toContain(`"base":"/r/${CODE}"`.replace(/"/g, '\\"'));
    expect(html).toContain('name="robots" content="noindex"');
    // Sin el vocabulario del personal (lo que pinta la página, no solo los textos). OxioPay sí
    // sale: es el producto (el logo y el dominio); OxioCard es solo la ficha.
    expect(html.replace(/<script>[\s\S]*?<\/script>/g, '')).not.toMatch(/dat[aá]fono|\bterminal\b|chica/i);
    expect(html).toContain('alt="OxioPay"');
  });

  it('el JS de la página no lleva barras invertidas (va dentro de una plantilla) salvo los escapes del JSON', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor({ enabled: true, cardBps: 1000, topUpBps: 1050 }));
    expect(HOME_JS).not.toContain('\\');
    // Fuera de la configuración en JSON (que sí escapa comillas), nada.
    const js = scripts(html).replace(/JSON\.parse\("(?:[^"\\]|\\.)*"\)/g, 'JSON.parse(CFG)');
    expect(js).not.toContain('\\');
  });

  it('con comisión: el botón dice lo que se paga y el total lo dice el servidor para cada importe (10–300 €, 0–12 %)', () => {
    for (let bps = 0; bps <= 1200; bps += 25) {
      const fee: VenueServiceFee = { enabled: true, cardBps: 1000, topUpBps: bps };
      const view = viewFor(fee);
      for (let cents = SELF_TOPUP_MIN_CENTS; cents <= SELF_TOPUP_MAX_CENTS; cents += 100) {
        const quote = serviceFeeQuote(fee, 'topUp', cents);
        const says = pageSays(view, cents);
        expect(says.total).toBe(cents + quote.feeCents);
        expect(says.label).toBe(quote.feeCents > 0 ? `Pagar EUR${cents + quote.feeCents}` : `Cargar EUR${cents}`);
      }
    }
  });

  it('sin comisión: «Cargar 50 €» y sin desglose; un importe que no vale, sin cifra', () => {
    const view = viewFor(null);
    const html = renderHomeTopUpPage(CODE, 'es', view);
    expect(html).not.toContain('id="brk"');
    expect(html).not.toContain(HOME_TOPUP_TEXT.es.refundFee);
    expect(pageSays(view, 5000)).toEqual({ label: 'Cargar EUR5000', total: 5000 });
    expect(pageSays(view, 900)).toEqual({ label: 'Cargar saldo', total: 900 });
    expect(pageSays(view, 30_100)).toEqual({ label: 'Cargar saldo', total: 30_100 });
    expect(pageSays(view, 5050)).toEqual({ label: 'Cargar saldo', total: 5050 });
  });

  it('el botón de pagar: fijo abajo con el total, candado y céntimos; «Pago seguro» con Visa y Mastercard', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor({ enabled: true, cardBps: 1000, topUpBps: 1200 }));
    // El error, dentro de la barra fija y encima del botón (fuera de ella quedaría tapado).
    expect(html).toMatch(/<div class="paybar"><p class="err" id="err" role="alert" hidden><\/p>\n<button class="btn" type="submit" id="go"><svg class="ic"[^>]*>.*?<\/svg><span id="goLbl"><\/span><\/button>/);
    expect(html).toContain('.topup .paybar{position:sticky;bottom:0');
    expect(html).toContain('<p class="foot trust">Pago seguro<span class="marks" role="img" aria-label="Visa, Mastercard">');
    // Lo que se cobra, con céntimos (el botón y el desglose); los límites, sin ellos.
    expect(HOME_JS).toContain("fill(T.goFee,'amount',eurP(c+f))");
    expect(HOME_JS).toContain("$('bTotal').textContent=good?eurP(c+f):''");
    expect(scripts(html)).toContain("function eurP(c){return npMoney(c,C.locale,'EUR',true);}");
    // Mientras abre el pago: su color con la ruedita, y no se pulsa dos veces.
    expect(HOME_JS).toContain("b.classList.toggle('busy',on)");
  });

  it('con comisión, antes de pagar dice que la comisión no se devuelve', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor({ enabled: true, cardBps: 1000, topUpBps: 1200 }));
    expect(html).toContain(HOME_TOPUP_TEXT.es.refundFee);
    expect(html).toContain('¿Qué es?');
  });

  it('este navegador ya tiene un saldo de aquí: «Recargar mi saldo» primero, con su código tapado', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { mine: { codeHint: 'K7Q-•••' } }));
    expect(html).toContain('Tu saldo K7Q-••• está en este móvil');
    expect(html).toContain(`href="/r/${CODE}/mi-saldo?lang=es"`);
    expect(html.indexOf('id="mineGo"')).toBeLessThan(html.indexOf('id="f"'));
  });

  it('el local no deja cargar ahora: el aviso, sin formulario ni JS de la carga', () => {
    const html = renderHomeTopUpPage(CODE, 'en', viewFor(null, { problem: 'methods', mine: { codeHint: 'K7Q-•••' } }));
    expect(html).toContain(HOME_TOPUP_TEXT.en.offTitle.replace(/'/g, '&#39;'));
    expect(html).not.toContain('id="f"');
    expect(html).not.toContain('id="mineGo"');
    expect(html).not.toContain('pkPost(');
  });

  it('un nombre de local con HTML se pinta como texto', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { venueName: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it.each(PAY_LANGUAGES)('%s: el 404 sin pistas (ni local ni por qué)', (lang) => {
    const html = renderHomeTopUpGone(lang);
    expect(html).toContain(HOME_TOPUP_TEXT[lang].notFoundTitle.replace(/'/g, '&#39;'));
    expect(html).not.toContain('Sala');
    expect(html).not.toContain('pkPost(');
  });
});

describe('/r explicada: la ventaja, cómo funciona y lo que no gaste', () => {
  /** El texto como sale en el HTML (escapeHtml cambia los apóstrofos rectos). */
  const inHtml = (s: string): string => s.replace(/'/g, '&#39;');

  it.each(PAY_LANGUAGES)('%s: la ventaja en una línea y los tres pasos, antes de elegir cuánto', (lang) => {
    const t = HOME_TOPUP_TEXT[lang];
    const html = renderHomeTopUpPage(CODE, lang, viewFor(null));
    expect(html).toContain(`<p>${inHtml(t.advantage)}</p>`);
    expect(html).toContain(
      `<ol class="tsteps" aria-label="${inHtml(t.howTitle)}"><li>${inHtml(t.stepChoose)}</li><li>${inHtml(t.stepPay)}</li><li>${inHtml(t.stepArrive)}</li></ol>`,
    );
    expect(html.indexOf('class="tsteps"')).toBeLessThan(html.indexOf('id="f"'));
    expect(html.indexOf('class="tsteps"')).toBeGreaterThan(html.indexOf('id="hTitle"'));
  });

  it('el paso 3 según el local: con fichas, el QR en recepción; sin ellas, solo el móvil', () => {
    const t = HOME_TOPUP_TEXT.es;
    const conFichas = renderHomeTopUpPage(CODE, 'es', viewFor(null, { fichas: true }));
    expect(conFichas).toContain(t.stepArrive);
    expect(conFichas).not.toContain(t.stepArriveNoFicha);
    const sinFichas = renderHomeTopUpPage(CODE, 'es', viewFor(null, { fichas: false }));
    expect(sinFichas).toContain(t.stepArriveNoFicha);
    expect(sinFichas).not.toContain(t.stepArrive);
    // Sin el dato (una vista de antes): como decía la página, con la ficha.
    expect(renderHomeTopUpPage(CODE, 'es', viewFor(null))).toContain(t.stepArrive);
  });

  it('ya tiene un saldo de aquí: los pasos arriba y «Recargar mi saldo» antes de cargar otro', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { mine: { codeHint: 'K7Q-•••' } }));
    expect(html.indexOf('class="tsteps"')).toBeLessThan(html.indexOf('id="mineGo"'));
    expect(html.indexOf('id="mineGo"')).toBeLessThan(html.indexOf('id="f"'));
  });

  it('el local no deja cargar ahora: sin los pasos (no hay nada que elegir ni pagar)', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { problem: 'paused' }));
    expect(html).not.toContain('class="tsteps"');
    expect(html).toContain(HOME_TOPUP_TEXT.es.offTitle);
  });

  it('el local no deja cargar ahora: primero el aviso y después las condiciones (no al revés)', () => {
    for (const problem of ['paused', 'methods'] as const) {
      const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { problem }));
      expect(html.indexOf(HOME_TOPUP_TEXT.es.offTitle)).toBeGreaterThan(-1);
      expect(html.indexOf(HOME_TOPUP_TEXT.es.offTitle)).toBeLessThan(html.indexOf('id="termsTitle"'));
    }
  });

  it('ya tiene un saldo de aquí: las condiciones antes de las dos formas; «O carga un saldo nuevo:» pegado al importe', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null, { mine: { codeHint: 'K7Q-•••' } }));
    expect(html.indexOf('id="termsTitle"')).toBeLessThan(html.indexOf('id="mineTitle"'));
    const or = `<p class="or">${HOME_TOPUP_TEXT.es.mineOr}</p>`;
    const at = html.indexOf(or);
    expect(at).toBeGreaterThan(html.indexOf('id="mineGo"'));
    // Lo siguiente tras «O carga un saldo nuevo:» es la tarjeta del importe, no otra.
    const next = html.slice(at + or.length).trimStart();
    expect(next.startsWith('<section class="card topup" aria-labelledby="amtTitle">')).toBe(true);
  });

  it('antes de pagar: lo que no gaste no se pierde (no caduca) y cómo se devuelve; al llegar ya va en los pasos', () => {
    const t = HOME_TOPUP_TEXT.es;
    const html = renderHomeTopUpPage(CODE, 'es', viewFor(null));
    const terms = html.slice(html.indexOf('id="termsTitle"'), html.indexOf('</section>', html.indexOf('id="termsTitle"')));
    expect(terms).toContain(`<b>${t.keep}</b> ${t.noExpiry}`);
    expect(terms).toContain(t.refund);
    expect(terms.match(/<li>/g)).toHaveLength(2);
    // Debajo del botón, solo lo que no dicen los pasos.
    expect(html).toContain(`<p class="small">${t.methods}</p></div>`);
  });

  it('con comisión: su «¿Qué es?» habla de la recarga (no del consumo) y dice que no va al saldo', () => {
    const html = renderHomeTopUpPage(CODE, 'es', viewFor({ enabled: true, cardBps: 1000, topUpBps: 1200 })).replace(/[\u00a0\u202f]/g, ' ');
    expect(html).toContain('Es un 12 % de la recarga, para la plataforma de pago. No va a tu saldo y no es una propina.');
    expect(html).not.toContain('del consumo');
    expect(WALLET_TEXT.es.topUpFeeExplain).toContain('{pct}');
  });
});
