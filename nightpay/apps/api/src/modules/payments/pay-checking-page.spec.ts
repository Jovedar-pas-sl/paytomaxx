import { describe, expect, it } from 'vitest';
import { RETRY_WAIT_MS } from '@nightpay/contracts';
import { PAY_LANGUAGES } from './customer-lang';
import { PAY_TEXT } from './pay-i18n';
import { CHECKING_JS, checkingPhase, renderCheckingPage, type CheckingPageInput } from './pay-checking-page';
import type { PayStatusView } from './pay-status';

const NOW = new Date('2026-10-17T23:41:30+02:00');
const sent = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

function statusView(o: Partial<PayStatusView> = {}): PayStatusView {
  const attemptStartedAt = o.attemptStartedAt ?? sent(5);
  return {
    state: 'processing',
    attemptStartedAt,
    retryAt: new Date(Date.parse(attemptStartedAt) + RETRY_WAIT_MS).toISOString(),
    qrExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    amountCents: 3_830,
    venueName: 'Sala Aurora',
    otherPayer: false,
    now: NOW.toISOString(),
    ...o,
  };
}

function page(o: Partial<CheckingPageInput> = {}, v: Partial<PayStatusView> = {}): string {
  return renderCheckingPage(
    {
      mode: 'processing',
      view: statusView(v),
      lang: 'es',
      currency: 'EUR',
      concept: '2× Gin tonic · Nachos',
      ref: 'C-0012',
      statementName: 'SALA AURORA MADRID',
      statusUrl: '/pay/tok-1/status',
      finalUrl: '/pay/tok-1?lang=es',
      retryHref: '/pay/tok-1?lang=es',
      saldoHref: '/s/saldo-1?lang=es',
      langHref: (l) => `/pay/tok-1?lang=${l}`,
      ...o,
    },
    NOW,
  );
}

const visible = (html: string, id: string): boolean => {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return false;
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  return !/ hidden(>|\s)/.test(tag);
};

describe('«Comprobando el pago»: lo que se pinta en cada fase (05-ui-ux §4.3)', () => {
  it('0–20 s: importe, local, concepto, los tres pasos (enviado ✓, reloj) y «Confirmando con tu banco…»', () => {
    const html = page();
    expect(html).toContain('<title>Comprobando el pago</title>');
    expect(html).toContain('Sala Aurora');
    expect(html).toContain('38,30');
    expect(html).toContain('2× Gin tonic · Nachos');
    for (const step of ['Pago enviado a tu banco', 'Tu banco lo confirma', 'Pagado']) expect(html).toContain(step);
    expect(html).toContain('id="ckTitle">Confirmando con tu banco…</h1>');
    // El reloj de la espera, oculto al lector de pantalla.
    expect(html).toMatch(/id="ckClock" aria-hidden="true">0:05</);
    // Antes de los 8 s, sin «Suele tardar…»; nada que hacer aún.
    expect(visible(html, 'ckBody')).toBe(false);
    expect(visible(html, 'ckShow')).toBe(false);
    expect(visible(html, 'ckRetry')).toBe(false);
    expect(html).toContain('data-phase="start"');
  });

  it('desde los 8 s: «Suele tardar unos segundos. No cierres esta página.»', () => {
    const html = page({}, { attemptStartedAt: sent(12) });
    expect(visible(html, 'ckBody')).toBe(true);
    expect(html).toContain('Suele tardar unos segundos. No cierres esta página.');
  });

  it('20–60 s: «Tu banco está tardando un poco», no pagues otra vez, y «Enseñar al camarero» con la placa', () => {
    const html = page({}, { attemptStartedAt: sent(25) });
    expect(html).toContain('data-phase="slow"');
    expect(html).toContain('Tu banco está tardando un poco');
    expect(html).toContain('No pagues otra vez: si se cobra, lo verás aquí.');
    expect(visible(html, 'ckShow')).toBe(true);
    // La placa: importe, referencia corta y hora del envío.
    expect(html).toContain('Enseñar al camarero');
    expect(html).toContain('C-0012');
    expect(html).toContain('Enviado a tu banco a las 23:41');
    expect(visible(html, 'ckBank')).toBe(false);
  });

  it('60 s–2:30: «Seguimos esperando a tu banco», la cuenta atrás para reintentar y «¿Ves el cargo en tu app del banco?»', () => {
    const html = page({}, { attemptStartedAt: sent(63) });
    expect(html).toContain('data-phase="still"');
    expect(html).toContain('Seguimos esperando a tu banco');
    expect(html).toContain('Podrás intentarlo otra vez en 1:27.');
    expect(visible(html, 'ckBank')).toBe(true);
    expect(html).toContain('Busca «SALA AURORA MADRID» de 38,30');
  });

  it('pasados 2:30 con el QR vigente: «Tu banco no ha contestado», «Intentar otra vez» y «Pagar con mi saldo»', () => {
    const html = page({}, { attemptStartedAt: sent(160) });
    expect(html).toContain('data-phase="retry"');
    expect(html).toContain('Tu banco no ha contestado');
    expect(html).toContain('Puedes intentarlo otra vez.');
    expect(visible(html, 'ckRetry')).toBe(true);
    expect(visible(html, 'ckSaldo')).toBe(true);
    expect(html).toContain('href="/pay/tok-1?lang=es"');
    expect(html).toContain('href="/s/saldo-1?lang=es"');
  });

  it('sin «Pagar con mi saldo» si el cobro no se puede pagar con él; sin reintento posible, sigue esperando', () => {
    expect(page({ saldoHref: null }, { attemptStartedAt: sent(160) })).not.toContain('id="ckSaldo"');
    const noRetry = page({}, { attemptStartedAt: sent(160), retryAt: null });
    expect(noRetry).toContain('data-phase="still"');
    expect(visible(noRetry, 'ckRetryIn')).toBe(false);
  });

  it('sin confirmación del banco: la misma plantilla, «Tu banco aún no lo ha confirmado», sin reintentar, cada 5 s', () => {
    const html = page({ mode: 'unconfirmed', retryHref: null, saldoHref: null }, { state: 'unconfirmed', retryAt: null, attemptStartedAt: sent(400) });
    expect(html).toContain('data-mode="unconfirmed"');
    expect(html).toContain('Tu banco aún no lo ha confirmado');
    expect(html).toContain('Esta pantalla lo sigue comprobando sola.');
    expect(html).not.toContain('id="ckRetry"');
    expect(visible(html, 'ckBank')).toBe(true);
    expect(html).toContain('content="5;url=/pay/tok-1?lang=es"');
    expect(html).toContain('"unconfirmedEveryMs":5000');
    expect(html).toContain('"unconfirmedForMs":1800000');
  });

  it('otra persona en el mismo QR: «Alguien está pagando este cobro ahora mismo»', () => {
    expect(visible(page({}, { otherPayer: true }), 'ckOther')).toBe(true);
    expect(visible(page(), 'ckOther')).toBe(false);
    expect(page()).toContain('Alguien está pagando este cobro ahora mismo.');
  });

  it('sin el nombre del extracto: la frase sin nombre', () => {
    expect(page({ statementName: null }, { attemptStartedAt: sent(63) })).toContain('Busca un cargo de 38,30');
  });

  it('sin JS se recarga sola cada 5 s; la región viva cambia solo de fase; nunca promete devolver ni dice «no se te ha cobrado»', () => {
    const html = page();
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="5;url=/pay/tok-1?lang=es"></noscript>');
    expect(html).toContain('id="ckLive" aria-live="polite"');
    expect(html).not.toMatch(/devuelve uno|cobrara los dos/);
    expect(html).not.toContain('No se te ha cobrado');
    // «Sin conexión» está, oculta hasta que falle la red.
    expect(visible(html, 'ckOffline')).toBe(false);
    expect(html).toContain('Sin conexión. Tu pago no se pierde');
  });

  it('la consulta: su URL, a dónde ir al acabar, las esperas 1, 1, 2, 2, 3 s y luego 5 s, y 8 s de plazo', () => {
    const html = page();
    const cfg = JSON.parse(html.slice(html.indexOf('id="ckCfg">') + 11, html.indexOf('</script>', html.indexOf('id="ckCfg">')))) as Record<string, unknown>;
    expect(cfg).toMatchObject({
      mode: 'processing',
      statusUrl: '/pay/tok-1/status',
      finalUrl: '/pay/tok-1?lang=es',
      delays: [1000, 1000, 2000, 2000, 3000],
      everyMs: 5000,
      timeoutMs: 8000,
      slowMs: 20000,
      stillMs: 60000,
      hintMs: 8000,
    });
    // Sin poder cerrar el <script> con lo que lleve dentro.
    const evil = page({ concept: null }, { venueName: '</script><script>alert(1)</script>' });
    expect(evil).not.toContain('</script><script>alert(1)');
  });

  it.each(PAY_LANGUAGES)('%s: los textos de cada fase en su idioma', (lang) => {
    const t = PAY_TEXT[lang].checking;
    const html = page({ lang }, { attemptStartedAt: sent(63) });
    expect(html).toContain(`lang="${lang}"`);
    for (const text of [t.still, t.steps[0], t.steps[1], t.steps[2], t.showStaff, t.bankAppTitle]) {
      expect(html).toContain(text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    }
  });

  it('el JS de la página no lleva barras invertidas (va dentro de una plantilla)', () => {
    expect(CHECKING_JS).not.toContain(String.fromCharCode(92));
    // Consulta con plazo y al volver a la pestaña o a la red; al acabar, replace (sin dejar historial).
    for (const piece of ['AbortController', 'visibilitychange', "'online'", 'location.replace', "cache:'no-store'"]) expect(CHECKING_JS).toContain(piece);
  });
});

describe('la fase según el tiempo (la misma en el servidor y en la página)', () => {
  const base = statusView({ attemptStartedAt: NOW.toISOString() });
  const at = (seconds: number) => NOW.getTime() + seconds * 1000;
  it('start, slow, still y retry', () => {
    expect(checkingPhase('processing', base, at(0))).toBe('start');
    expect(checkingPhase('processing', base, at(20))).toBe('slow');
    expect(checkingPhase('processing', base, at(60))).toBe('still');
    expect(checkingPhase('processing', base, at(150))).toBe('retry');
    // Con el QR caducado ya no se reintenta.
    expect(checkingPhase('processing', { ...base, qrExpiresAt: new Date(at(100)).toISOString() }, at(150))).toBe('still');
    expect(checkingPhase('unconfirmed', base, at(0))).toBe('unconfirmed');
  });
});
