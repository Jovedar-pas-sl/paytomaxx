import { describe, it, expect } from 'vitest';
import { renderQrChargePage } from './qr-charge-page';
import { renderPaidPage } from '../payments/public-pay.pages';

const scripts = (html: string): string[] =>
  html.split('<script>').slice(1).map((part) => part.slice(0, part.indexOf('</script>')));

describe('pagar con el saldo escaneando el QR del personal', () => {
  const NOW = new Date('2026-10-15T22:00:00Z');
  const view = {
    status: 'PENDING' as const,
    amountCents: 6000,
    serviceName: 'Masaje',
    venueName: 'Luna',
    requestedByName: 'Lola',
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    paidAt: null,
  };

  it('importe, servicio y el botón; su JS es válido (si se rompe, el cliente no puede pagar)', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderQrChargePage('tok-1', lang, view, NOW);
      expect(html).toContain('id="pay"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderQrChargePage('tok-1', 'es', view, NOW);
    expect(es).toContain('Pagar con mi saldo');
    // Face ID preparado al abrir: al tocar "Pagar" sale al momento.
    expect(es).toContain("pkPrepare(C.base+'/challenge')");
    expect(es).toContain('PIN');
    expect(es).toContain('/s/tok-1');
  });

  it('cobro único ya pagado con tarjeta: «Ya está pagado con tarjeta» y que del saldo no se cobró nada', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, status: 'CANCELED', paidElsewhere: true }, NOW);
    expect(html).toContain('Ya está pagado con tarjeta');
    expect(html).toContain('De tu saldo no se ha cobrado nada.');
    expect(html).not.toContain('id="pay"');
    expect(renderQrChargePage('tok-1', 'en', { ...view, status: 'CANCELED', paidElsewhere: true }, NOW)).toContain('Already paid by card');
  });

  it('al pagar: el mismo «Pagado» a pantalla completa, con «Te quedan X €» y la pantalla encendida', () => {
    const html = renderQrChargePage('tok-1', 'es', view, NOW);
    // El «Pagado» ya está en la página (oculto) y el JS lo enseña al pagar.
    expect(html).toContain('class="paid stale" id="paid"');
    expect(html).toMatch(/id="paid"[^>]* hidden>/);
    const js = scripts(html).join('\n');
    expect(js).toContain('Te quedan');
    expect(js).toContain('npPaid(el,T.paid)');
    expect(js).toContain("navigator.wakeLock.request('screen')");
    expect(js).not.toContain('alert(');
  });

  it('el «Pagado» trae el código del cobro único (el mismo que ve el personal); sin él, ningún código', () => {
    const withCode = renderQrChargePage('tok-1', 'es', { ...view, code: '0C1' }, NOW);
    expect(withCode).toContain('<b class="num">0C1</b>');
    expect(withCode).toContain('El mismo que ve el personal');
    const without = renderQrChargePage('tok-1', 'es', { ...view, code: null }, NOW);
    expect(without).not.toContain('class="pcode"');
  });

  it('cobro ya pagado hace rato → «Ya pagado · hace 23 min» en gris, sin botón de pagar', () => {
    const html = renderQrChargePage(
      'tok-1',
      'es',
      { ...view, status: 'ACCEPTED', paidAt: new Date(NOW.getTime() - 23 * 60_000).toISOString() },
      NOW,
    );
    expect(html).toContain('class="paid stale" id="paid"');
    expect(html).not.toMatch(/id="paid"[^>]* hidden>/);
    expect(html).toContain('Ya pagado');
    expect(html).toContain('hace 23 min');
    expect(html).toContain('Pagado con tu saldo a las');
    expect(html).not.toContain('Confirmado por el banco');
    expect(html).not.toContain('id="pay"');
    expect(html).not.toContain('No se te ha cobrado nada');
  });

  it('pagado hace un momento, abierto en OTRO móvil (el QR de la chica) → «Ya pagado» en gris; el lima solo tras SU pago', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, status: 'ACCEPTED', paidAt: new Date(NOW.getTime() - 5_000).toISOString() }, NOW);
    expect(html).toContain('class="paid stale" id="paid"');
    expect(html).toContain('>Ya pagado</h1>');
    // El «Pagado» lima lo pinta el JS con la respuesta de su pago.
    expect(html).toContain("el.classList.remove('stale')");
  });

  it('caducado → qué pasó, «No se te ha cobrado nada» y una indicación', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, status: 'EXPIRED' }, NOW);
    expect(html).toContain('Este cobro ha caducado');
    expect(html).toContain('No se te ha cobrado nada');
    expect(html).toContain('Pide al personal que lo repita');
    expect(html).not.toContain('id="pay"');
  });

  it('error al pagar: solo dice que no se cobró si el servidor contestó (y no es un 409)', () => {
    const js = scripts(renderQrChargePage('tok-1', 'es', view, NOW)).join('\n');
    expect(js).toContain('if(!e||!e.status)');
    expect(js).toContain("if(e.status===409)$('reload').hidden=false;else $('notCharged').hidden=false;");
  });

  it('un nombre con HTML no puede cerrar el <script>', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, serviceName: '</script><img src=x onerror=alert(1)>' }, NOW);
    expect(html).not.toContain('</script><img');
  });
});

describe('"Pagado" de la recarga que creó el saldo', () => {
  const base = {
    amountCents: 20_000,
    tipCents: 0,
    currency: 'EUR',
    code: 'A1B',
    authorizedAt: new Date('2026-10-14T22:00:00Z'),
    now: new Date('2026-10-14T22:00:05Z'),
    receiptHref: null,
    walletHref: '/w/wt?lang=es',
  };

  it('sin Face ID: UNA pregunta (activar, con «Ahora no»), explicada antes; sin PIN en el mismo paso; JS válido', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderPaidPage({ ...base, wallet: { hasFaceId: false, base: '/pay/qr1' } }, lang);
      expect(html).toContain('id="fidOn"');
      expect(html).toContain('id="fidLater"');
      expect(html).not.toContain('id="pinBox"');
      expect(html).not.toContain('id="pkMerge"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderPaidPage({ ...base, wallet: { hasFaceId: false, base: '/pay/qr1' } }, 'es');
    expect(es).toContain('Ahora no');
    // Palabras de cada plataforma, elegidas en el móvil.
    expect(es).toContain('Activar Face ID');
    expect(es).toContain('huella o bloqueo de pantalla');
    expect(es).toContain('Solo quien desbloquee este móvil puede gastar tu saldo');
    expect(es).toContain("pkCreate(C.base+'/passkey/options')");
    // El PIN y sumar a otro saldo, en la página del saldo.
    expect(es).toContain('href="/w/wt?lang=es#sumar"');
    expect(es).toContain('href="/w/wt?lang=es"');
  });

  it('con Face ID: solo la confirmación, sin pregunta ni «sumar»', () => {
    const html = renderPaidPage({ ...base, wallet: { hasFaceId: true, base: '/pay/qr1' } }, 'es');
    expect(html).not.toContain('#sumar');
    expect(scripts(html).join('\n')).toContain('if(C.hasFaceId)');
    for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
  });

  it('otra recarga (sin saldo nuevo): sin pregunta de Face ID', () => {
    const html = renderPaidPage({ ...base, wallet: null }, 'es');
    expect(html).not.toContain('id="fidOn"');
    expect(html).toContain('Ver mi saldo');
  });
});
