import { describe, it, expect } from 'vitest';
import { PAY_FAIL_JS, renderQrChargePage } from './qr-charge-page';
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
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const html = renderQrChargePage('tok-1', lang, view, NOW);
      expect(html).toContain('id="pay"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderQrChargePage('tok-1', 'es', view, NOW);
    expect(es).toContain('Pagar con mi saldo');
    // Lo que se cobra, con céntimos, como en las demás páginas de pago.
    expect(es).toMatch(/<h1 class="amount num" id="amt">60,00\s€<\/h1>/);
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

  it('sin pagar, el código NO va en la página (ni en el HTML ni en su configuración): un «Pagado» falso no lo tiene', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, code: 'Z9Q' }, NOW);
    expect(html).not.toContain('Z9Q');
    expect(html).not.toContain('class="pcode"');
  });

  it('ya pagado al abrirla: el «Pagado» trae el código del cobro único (el mismo que ve el personal); sin él, ninguno', () => {
    const paid = { ...view, status: 'ACCEPTED' as const, paidAt: new Date(NOW.getTime() - 60_000).toISOString() };
    const withCode = renderQrChargePage('tok-1', 'es', { ...paid, code: 'Z9Q' }, NOW);
    expect(withCode).toContain('<b class="num">Z9Q</b>');
    expect(withCode).toContain('Enséñaselo al personal');
    const without = renderQrChargePage('tok-1', 'es', { ...paid, code: null }, NOW);
    expect(without).not.toContain('class="pcode"');
  });

  it('pagado aquí mismo: el código llega en la respuesta del pago y el JS lo pinta (con su rótulo)', () => {
    const html = renderQrChargePage('tok-1', 'es', view, NOW);
    const js = scripts(html).join('\n');
    expect(js).toContain('if(r.code)');
    expect(js).toContain("className='pcode'");
    expect(html).toContain('Enséñaselo al personal');
  });

  it('cobro ya pagado hace 4 min → «Ya pagado · hace 4:00» en gris, sin botón de pagar', () => {
    const html = renderQrChargePage(
      'tok-1',
      'es',
      { ...view, status: 'ACCEPTED', paidAt: new Date(NOW.getTime() - 4 * 60_000).toISOString() },
      NOW,
    );
    expect(html).toContain('class="paid stale" id="paid"');
    expect(html).not.toMatch(/id="paid"[^>]* hidden>/);
    expect(html).toContain('Ya pagado');
    expect(html).toContain('hace 4:00');
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

  it('«Ver mi saldo» en todas las pantallas que acaban: tras pagar aquí, el enlace de la respuesta; si no, con Face ID', () => {
    // Ya pagado (QR que se vuelve a abrir), pagado con tarjeta o caducado: con Face ID, enseñado al cargar.
    for (const v of [
      { ...view, status: 'ACCEPTED' as const, paidAt: new Date(NOW.getTime() - 60_000).toISOString() },
      { ...view, status: 'CANCELED' as const, paidElsewhere: true },
      { ...view, status: 'EXPIRED' as const },
    ]) {
      const html = renderQrChargePage('tok-1', 'es', v, NOW);
      expect(html).toContain('id="npMine"');
      expect(html.match(/id="npMine"/g)).toHaveLength(1);
      expect(html).toMatch(/^npMineShow[(]true[)];$/m);
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    // Sin pagar: nada al cargar; al pagar, el enlace de su saldo (solo una ruta /w/<enlace>) o, sin él, Face ID.
    const pending = renderQrChargePage('tok-1', 'en', view, NOW);
    expect(pending).toContain('See my balance');
    expect(pending).not.toMatch(/^npMineShow[(]true[)];$/m);
    const js = scripts(pending).join('');
    expect(js).toContain('r.walletUrl&&/^[/]w[/][A-Za-z0-9_-]+$/.test(r.walletUrl)');
    expect(js).toContain('window.npMineShow(true)');
  });

  describe('la propina la elige el cliente (B1), sin nada marcado', () => {
    const tip = { baseCents: 3300, previousCents: 0, maxCents: 3300, presets: [{ cents: 200, percent: null }, { cents: 500, percent: null }], toStaff: true };
    const checked = (html: string) => html.match(/<input type="radio" name="tip" value="\d+"[^>]* checked>/g) ?? [];

    it('«Sin propina», las sugeridas del local y «Otra», sin ninguna marcada; el importe, sin propina', () => {
      for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
        const html = renderQrChargePage('tok-1', lang, { ...view, amountCents: 3300, tip }, NOW);
        expect(html).toContain('<fieldset class="tips">');
        expect(checked(html)).toEqual([]);
        expect(html).toContain('id="otherRadio"');
        for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
      }
      const es = renderQrChargePage('tok-1', 'es', { ...view, amountCents: 3300, tip }, NOW);
      expect(es).toContain('>Sin propina</span>');
      expect(es).toMatch(/>\+2\s€<\/span>/);
      expect(es).toMatch(/>\+5\s€<\/span>/);
      expect(es).toMatch(/<h1 class="amount num" id="amt">33,00\s€<\/h1>/);
      expect(es).toMatch(/<p class="tipline num" id="tipLine" hidden><\/p>/);
      // La propina es entera de la chica que cobra: se le dice (como en /pay).
      expect(es).toContain('Va entera para el personal');
      // Se manda con el pago (y «Otra» mal puesta se dice antes de pedir Face ID).
      const js = scripts(es).join('');
      expect(js).toContain("pkPost(C.base+'/pay',tp?{response:k,tipCents:tp.tip}:{response:k})");
      expect(js).toContain("tipErr(tp.error==='max'?TP.tooHigh:TP.empty)");
    });

    it('la que ya eligió en /pay sale marcada (también en «Otra»); la de un cobro de antes, marcada y se puede quitar', () => {
      const fromPay = renderQrChargePage('tok-1', 'es', { ...view, amountCents: 3300, tip }, NOW, { tipFromPay: 500 });
      expect(checked(fromPay)).toEqual(['<input type="radio" name="tip" value="500" checked>']);
      expect(fromPay).toMatch(/<h1 class="amount num" id="amt">38,00\s€<\/h1>/);
      expect(fromPay.replace(new RegExp(String.fromCharCode(160), 'g'), ' ')).toContain('<p class="tipline num" id="tipLine">33 € + 5 € de propina</p>');
      const other = renderQrChargePage('tok-1', 'es', { ...view, amountCents: 3300, tip }, NOW, { tipFromPay: 700 });
      expect(other).toContain('id="otherRadio" checked');
      expect(other).toContain('value="7"');
      // Por encima del máximo o con céntimos que «Otra» no admite: como si no viniera.
      expect(checked(renderQrChargePage('tok-1', 'es', { ...view, amountCents: 3300, tip }, NOW, { tipFromPay: 999_00 }))).toEqual([]);
      const old = renderQrChargePage('tok-1', 'es', { ...view, amountCents: 3800, tip: { ...tip, previousCents: 500 } }, NOW);
      expect(checked(old)).toEqual(['<input type="radio" name="tip" value="500" checked>']);
      expect(old).toContain('>Sin propina</span>');
    });

    it('sin propinas (local o puesto) no hay nada que elegir: se paga lo que dice el cobro', () => {
      const html = renderQrChargePage('tok-1', 'es', { ...view, tip: null }, NOW);
      expect(html).not.toContain('<fieldset class="tips">');
      expect(html).toMatch(/<h1 class="amount num" id="amt">60,00\s€<\/h1>/);
    });
  });

  it('error al pagar: solo dice que no se cobró si el servidor lo rechazó (4xx que no es 409)', () => {
    const payFail = new Function(`${PAY_FAIL_JS}; return npPayFail;`)() as (e: unknown) => string;
    // Sin respuesta o fallo del servidor (5xx): no se sabe si se cobró (el cobro pudo
    // hacerse y fallar después). Nada de «No se te ha cobrado nada» ni de volver a pagar.
    expect(payFail(null)).toBe('unknown');
    expect(payFail({ name: 'TypeError' })).toBe('unknown');
    expect(payFail({ status: 0 })).toBe('unknown');
    expect(payFail({ status: 500 })).toBe('unknown');
    expect(payFail({ status: 503, code: 'TRY_LATER' })).toBe('unknown');
    // 408 y 429 (un proxy que corta, un reintento): tampoco dicen si se cobró.
    expect(payFail({ status: 408 })).toBe('unknown');
    expect(payFail({ status: 429, code: 'RATE_LIMITED' })).toBe('unknown');
    // 409: ya no está pendiente, ya pagado, otro intento…: recargar enseña el estado real.
    expect(payFail({ status: 409, code: 'CHARGE_NOT_PENDING' })).toBe('reload');
    // Otro 4xx (Face ID, local en pausa…): rechazado antes de cobrar.
    expect(payFail({ status: 403, code: 'FACE_ID_WRONG' })).toBe('notCharged');
    expect(payFail({ status: 423, code: 'VENUE_PAUSED' })).toBe('notCharged');
  });

  it('si no se sabe si se cobró, pregunta el estado antes de dejar pagar otra vez (lo que ve el cliente: qr-charge-page.client.spec.ts)', () => {
    const js = scripts(renderQrChargePage('tok-1', 'es', view, NOW)).join('\n');
    expect(js).toContain(PAY_FAIL_JS);
    expect(js).toContain("fetch(C.base+'/state',{cache:'no-store'");
    expect(js).toContain("if(k==='reload'){$('reload').hidden=false;$('pay').hidden=true;}else $('notCharged').hidden=false;");
  });

  it('la cuenta atrás lleva la hora del servidor (la del móvil puede ir mal)', () => {
    const html = renderQrChargePage('tok-1', 'es', view, NOW);
    expect(html).toContain(`\\"now\\":${NOW.getTime()}`);
    expect(scripts(html).join('\n')).toContain('exp-Date.now()-skew');
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
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
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
