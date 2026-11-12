import { describe, it, expect } from 'vitest';
import type { BtcpayInvoiceView } from '@nightpay/contracts';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { PAY_TEXT } from '../payments/pay-i18n';
import { renderBitcoinPage, safeHttpsLink, safeQrLink } from './btcpay-pay-page';

const view = (over: Partial<BtcpayInvoiceView> = {}): BtcpayInvoiceView => ({
  invoiceId: 'INV1',
  status: 'New',
  amountCents: 5650,
  amountBtc: '0.00088312',
  rate: '64000',
  qrLink: 'bitcoin:bc1qxyz?amount=0.00088312&lightning=lnbc883120n1p3xyzabcdefghijklmnopqrstuvwxyz0123',
  chainAddress: 'bc1qxyz',
  checkoutLink: 'https://pay.sala-bambu.es/i/INV1',
  expiresAt: '2026-11-14T22:15:00.000Z',
  paymentStatus: 'AUTHORIZING',
  qrImage: 'data:image/png;base64,iVBORw0KGgo=',
  ...over,
});
const base = { token: 'tok-1', lang: 'es' as const, venueName: 'Sala Bambú', concept: '2× Copa', langHref: (l: string) => `/pay/tok-1/bitcoin?lang=${l}` };
const html = (v = view(), over: Record<string, unknown> = {}, lang: (typeof PAY_LANGUAGES)[number] = 'es') =>
  renderBitcoinPage({ ...base, lang, view: v, ...over } as never);

describe('página «Pagar con bitcoin»', () => {
  it('enseña el QR, el importe en euros y en BTC, abrir en la cartera, copiar y el tiempo', () => {
    const page = html();
    expect(page).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(page).toContain('56,50');
    expect(page).toContain('0.00088312 BTC');
    expect(page).toContain('href="bitcoin:bc1qxyz?amount=0.00088312&amp;lightning=lnbc883120n1p3xyzabcdefghijklmnopqrstuvwxyz0123"');
    expect(page).toContain('id="btcCopy"');
    expect(page).toContain('value="bc1qxyz"');
    expect(page).toContain('https://pay.sala-bambu.es/i/INV1');
    expect(page).toContain('/pay/tok-1/bitcoin/status');
    expect(page).toContain('id="btcClock"');
    expect(page).toContain('Sala Bambú');
  });

  it.each(PAY_LANGUAGES)('sale en %s con su título y su botón', (lang) => {
    const page = html(view(), {}, lang);
    expect(page).toContain(`<html lang="${lang}"`);
    expect(page).toContain('id="btcOpen"');
    expect(page.length).toBeGreaterThan(2_000);
  });

  it('el JS de la página no lleva barras invertidas (regla del proyecto) y la CSP lo deja: todo inline y propio', () => {
    const page = html();
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s.includes(String.fromCharCode(92)), 'barra invertida en un <script>').toBe(false);
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).not.toMatch(/<link[^>]+rel="stylesheet"/);
  });

  it('el JSON de la configuración no puede cerrar la etiqueta', () => {
    const page = html(view({ chainAddress: 'bc1q</script><b>' }));
    const cfg = /<script type="application\/json" id="btcCfg">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    expect(cfg).not.toContain('</script');
    expect(cfg).not.toContain('<');
    expect(JSON.parse(cfg).copy).toContain('</script>');
  });

  it('lo que llega de BTCPay se escapa: dirección y nombre del local', () => {
    const page = html(view({ chainAddress: '"><img src=x onerror=alert(1)>' }), { venueName: '<b>Local</b>' });
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<b>Local</b>');
    expect(page).toContain('&lt;b&gt;Local&lt;/b&gt;');
  });

  it('solo enlaces bitcoin:/lightning: en el botón y https en la página de pago', () => {
    expect(safeQrLink('bitcoin:bc1q?amount=1')).toBeTruthy();
    expect(safeQrLink('lightning:lnbc1abc')).toBeTruthy();
    for (const bad of ['javascript:alert(1)', 'https://evil.example', 'bitcoin: x', 'bitcoin:a"b', 'data:text/html,x', '']) expect(safeQrLink(bad), bad).toBeNull();
    expect(safeHttpsLink('https://pay.x.es/i/1')).toBeTruthy();
    for (const bad of ['http://pay.x.es', 'javascript:1', 'https://a b', 'https://x"y']) expect(safeHttpsLink(bad), bad).toBeNull();
    // Un enlace malo no pinta QR ni botón: la página dice que no se puede.
    const page = html(view({ qrLink: 'javascript:alert(1)' }));
    expect(page).not.toContain('javascript:alert');
    expect(page).not.toContain('id="btcOpen"');
  });

  it('sin enlace de pago completo (no https) no pinta ese enlace', () => {
    expect(html(view({ checkoutLink: 'http://pay.x.es/i/1' }))).not.toContain('http://pay.x.es');
  });

  it('factura caducada o con problema: sin QR y con «elegir otra forma de pagar» hacia /pay/:token', () => {
    const expired = html(view(), { closed: 'expired' });
    expect(expired).not.toContain('iVBORw0KGgo=');
    expect(expired).toContain('href="/pay/tok-1?lang=es"');
    const problem = html(view(), { closed: 'problem' });
    expect(problem).toContain('no se ha dado por pagado');
  });

  it('el token del cobro va codificado en las rutas', () => {
    const page = html(view(), { token: 'a/b c' });
    expect(page).toContain('/pay/a%2Fb%20c/bitcoin/status');
    expect(page).toContain('action="/pay/a%2Fb%20c/bitcoin/other?lang=es"');
  });
});

describe('«Pagar de otra forma» con el QR a la vista', () => {
  const form = (page: string): string => /<form[^>]*id="btcOther"[\s\S]*?<\/form>/.exec(page)?.[0] ?? '';

  it('mientras la factura espera el pago: un botón que cierra la factura y vuelve a las demás formas (POST)', () => {
    const f = form(html());
    expect(f).toContain('method="post"');
    expect(f).toContain('action="/pay/tok-1/bitcoin/other?lang=es"');
    expect(f).toContain('>Pagar de otra forma<');
    expect(f).not.toMatch(/<form[^>]*hidden/);
  });

  it('con el pago ya en la red (Processing) no se ofrece: se está confirmando', () => {
    expect(form(html(view({ status: 'Processing' })))).toMatch(/<form[^>]*id="btcOther"[^>]*hidden/);
  });

  it('la página lo esconde sola si el pago llega a la red mientras se mira, y no se envía dos veces', () => {
    const page = html();
    expect(page).toContain("if(other)other.hidden=d.status==='Processing';");
    expect(page).toContain("other.addEventListener('submit'");
    // Al volver atrás (caché del navegador), la página se recarga: nada de un QR viejo.
    expect(page).toContain("window.addEventListener('pageshow',function(e){if(e.persisted)location.reload();});");
  });

  it.each(PAY_LANGUAGES)('en %s, con el texto de su idioma', (lang) => {
    const f = form(html(view(), {}, lang));
    expect(f).toContain(`/bitcoin/other?lang=${lang}`);
    expect(f).toContain(`>${PAY_TEXT[lang].bitcoin.payOtherWay}<`);
  });

  it('en inglés: «Pay another way»', () => {
    expect(form(html(view(), {}, 'en'))).toContain('>Pay another way<');
  });

  it('factura caducada o con problema: sin el botón (ya lleva «elegir otra forma de pagar»)', () => {
    expect(html(view(), { closed: 'expired' })).not.toContain('id="btcOther"');
    expect(html(view(), { closed: 'problem' })).not.toContain('id="btcOther"');
  });
});
