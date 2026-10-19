import { describe, it, expect } from 'vitest';
import { renderWalletPage } from './wallet-page';
import type { ClientWalletState } from './wallet-charges.service';

function state(o: Partial<ClientWalletState> = {}): ClientWalletState {
  return {
    code: 'K7Q-4M2',
    balanceCents: 20_000,
    status: 'ACTIVE',
    closeRequested: false,
    hasFaceId: false,
    hasPin: false,
    merged: false,
    refund: null,
    cards: ['4242'],
    movements: [],
    ...o,
  };
}

const script = (html: string): string => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

describe('página del saldo del cliente', () => {
  it('lleva el estado inicial, el idioma y las rutas del saldo', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<title>Tu saldo OxioPay</title>');
    expect(html).toContain('\\"base\\":\\"/w/tok-1\\"');
    expect(html).toContain('K7Q-4M2');
    expect(html).toContain('noindex');
  });

  it('en inglés', () => {
    const html = renderWalletPage('tok-1', 'en', state());
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Your OxioPay balance');
  });

  it('un nombre con HTML no puede cerrar el <script>', () => {
    const html = renderWalletPage(
      'tok-1',
      'es',
      state({
        movements: [
          {
            kind: 'consumption',
            amountCents: -5000,
            label: '</script><img src=x onerror=alert(1)>',
            venueName: 'Local',
            at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(html).not.toContain('</script><img');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('sin QR del código (ya no se paga enseñándolo); con "Activar Face ID" y JS válido', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWalletPage('tok-1', lang, state());
      expect(html).not.toContain('class="qr"');
      expect(html).toContain('id="faceCard"');
      expect(() => new Function(script(html))).not.toThrow();
    }
    const es = renderWalletPage('tok-1', 'es', state());
    expect(es).toContain('Activar Face ID');
    expect(es).toContain('Solo quien desbloquee este móvil puede gastar tu saldo');
    expect(script(es)).toContain("pkCreate(C.base+'/passkey/options')");
  });

  it('ya no hay cobros que aceptar o rechazar aquí: se paga con el QR de la chica o con el PIN', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWalletPage('tok-1', lang, state());
      expect(html).not.toContain('id="pending"');
      expect(html).not.toContain('id="accept"');
      expect(script(html)).not.toContain('/requests/');
      // "Me voy" sigue.
      expect(script(html)).toContain("withKey('/close',{})");
    }
  });

  it('el saldo es el protagonista: grande, en el HTML desde el principio y anunciado al cambiar', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toMatch(/<p class="balance num" id="balance" aria-live="polite">200,00\s€<\/p>/);
  });

  it('sin confirm() ni alert(): «Me voy», PIN y sumar se hacen en hojas dentro de la página', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWalletPage('tok-1', lang, state());
      const js = script(html);
      expect(js).not.toContain('confirm(');
      expect(js).not.toContain('alert(');
      for (const id of ['leaveSheet', 'pinSheet', 'mergeSheet']) expect(html).toContain(`<dialog class="sheet" id="${id}"`);
      expect(js).toContain('showModal');
    }
  });

  it('PIN y sumar a otro saldo como acciones secundarias, con sus rutas en /w', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toContain('id="pinOpen"');
    expect(html).toContain('id="mergeOpen"');
    expect(html).toContain('id="leaveOpen"');
    const js = script(html);
    expect(js).toContain("withKey('/pin',{pin:a,pin2:c})");
    // Con Face ID, PIN y «Me voy» piden desbloquear el móvil (reto de /pin/challenge o /close/challenge).
    expect(js).toContain("pkGet(C.base+path+'/challenge')");
    expect(js).toContain('if(S.hasFaceId&&!pkSupported()){show(\'pinErr\',T.faceIdNeeded);return;}');
    expect(js).toContain("pkGet(C.base+'/merge/challenge')");
    expect(js).toContain("post('/merge',{response:k})");
    // Abre la hoja de sumar si viene del «Pagado» de la recarga.
    expect(js).toContain("location.hash==='#sumar'");
  });

  it('«Me voy»: cuánto, cómo (tarjeta ••4242 o efectivo) y en qué paso (Pedido → Aprobado → Devuelto)', () => {
    const html = renderWalletPage(
      'tok-1',
      'es',
      state({ closeRequested: true, refund: { stage: 'requested', amountCents: 20_000, methods: [] } }),
    );
    expect(html).toContain('id="refundCard"');
    expect(html).toContain('<li data-i="0">Pedido</li><li data-i="1">Aprobado</li><li data-i="2">Devuelto</li>');
    expect(html).toContain('te lo devuelve a tu tarjeta {cards} o en efectivo');
    expect(html).toContain('\\"cards\\":[\\"4242\\"]');
    expect(script(html)).toContain("'••'+c");
    expect(script(html)).toContain("aria-current','step'");
  });

  it('botones ocupados dicen qué pasa (no solo se apagan)', () => {
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain('busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending)');
    expect(js).toContain('busyBtn(b,true,T.unlockWaiting)');
  });

  it('el token va codificado en la ruta', () => {
    const html = renderWalletPage('a/b"c', 'es', state());
    expect(html).toContain('/w/a%2Fb%22c');
  });
});

describe('«Añadir a Google Wallet» en la página del saldo', () => {
  it('sin Google Wallet configurado no hay botón ni código para él', () => {
    for (const html of [renderWalletPage('tok-1', 'es', state()), renderWalletPage('tok-1', 'es', state(), { googleWallet: false })]) {
      expect(html).not.toContain('id="gwCard"');
      expect(html).not.toContain('google-wallet');
      expect(script(html)).not.toContain("post('/google-wallet')");
      expect(html).toContain('\\"gw\\":false');
    }
  });

  it('configurado: el botón OFICIAL desde nuestro dominio, como acción secundaria (tras «Más opciones»)', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { googleWallet: true });
    expect(html).toContain('<img src="/w/assets/google-wallet/es" width="298" height="50" alt="Añadir a Google Wallet">');
    expect(html.indexOf('id="gwCard"')).toBeGreaterThan(html.indexOf('id="more"'));
    expect(html.indexOf('id="gwCard"')).toBeLessThan(html.indexOf('id="codeCard"'));
    // Sale escondida: el JS la enseña solo en Android.
    expect(html).toContain('<section class="gw" id="gwCard" hidden');
    const en = renderWalletPage('tok-1', 'en', state(), { googleWallet: true });
    expect(en).toContain('<img src="/w/assets/google-wallet/en" width="283" height="50" alt="Add to Google Wallet">');
  });

  it('solo en Android, con el saldo activo, sin devolución en curso y sin sumar a otro', () => {
    for (const lang of ['es', 'en'] as const) {
      const js = script(renderWalletPage('tok-1', lang, state(), { googleWallet: true }));
      expect(js).toContain("if(gw)gw.hidden=!(P==='android'&&active&&!r&&!s.merged);");
      expect(js).toContain("var gw=C.gw?$('gwCard'):null;");
      expect(() => new Function(script(renderWalletPage('tok-1', lang, state(), { googleWallet: true })))).not.toThrow();
    }
  });

  it('al tocarlo: pide el enlace al API (con el token de /w) y abre Google Wallet; si falla, lo dice', () => {
    const js = script(renderWalletPage('tok-1', 'es', state(), { googleWallet: true }));
    expect(js).toContain("post('/google-wallet')");
    // Solo se abre un enlace de Google; si no, error.
    expect(js).toContain("u.indexOf('https://pay.google.com/gp/v/save/')===0)location.href=u;else show('gwErr',T.error);");
    expect(js).toContain("$('gwMsg').textContent=T.gwPreparing");
    expect(js).toContain("show('gwErr',msg(e))");
    // Al volver a la página, el texto de siempre (no «Preparando…»).
    expect(js).toContain("busy=false;b.disabled=false;$('gwMsg').textContent=T.gwHint;");
    expect(js).not.toContain('alert(');
    // Sin barras invertidas: el JS va dentro de una plantilla de TypeScript.
    const gwJs = js.slice(js.indexOf("$('gwAdd')"), js.indexOf('render(S);'));
    expect(gwJs.length).toBeGreaterThan(50);
    expect(gwJs.includes(String.fromCharCode(92))).toBe(false);
  });
});

describe('«Recargar» en la página del saldo', () => {
  const topUp = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 };

  it('botón debajo del saldo y hoja con 20 / 50 / 100 €, «Otra» y los límites; 50 € marcada', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    expect(html.indexOf('id="topupBox"')).toBeGreaterThan(html.indexOf('id="balance"'));
    expect(html.indexOf('id="topupBox"')).toBeLessThan(html.indexOf('id="faceCard"'));
    expect(html).toContain('<dialog class="sheet" id="topupSheet"');
    expect(html).toMatch(/value="2000"><span class="num">20\s€<\/span>/);
    expect(html).toMatch(/value="5000" checked><span class="num">50\s€<\/span>/);
    expect(html).toMatch(/value="10000"><span class="num">100\s€<\/span>/);
    expect(html).toContain('id="amtOther"');
    expect(html).toMatch(/De 10\s€ a 300\s€\./);
    expect(html).toContain('Sin propina: solo pagas lo que recargas.');
    const en = renderWalletPage('tok-1', 'en', state(), { topUp });
    expect(en).toContain('Top up your balance');
    expect(en).toContain('From €10 to €300.');
  });

  it('JS válido, sin barras invertidas, y solo va a nuestra página de pago', () => {
    for (const lang of ['es', 'en'] as const) {
      const js = script(renderWalletPage('tok-1', lang, state(), { topUp, googleWallet: true }));
      expect(() => new Function(js)).not.toThrow();
      const top = js.slice(js.indexOf('var TU='), js.indexOf('render(S);'));
      expect(top.length).toBeGreaterThan(500);
      expect(top.includes(String.fromCharCode(92))).toBe(false);
      expect(js).toContain("post('/topup',body)");
      expect(js).toContain("pkGet(C.base+'/topup/challenge')");
      expect(js).toContain("u.indexOf('/pay/')===0");
      expect(js).not.toContain('confirm(');
      expect(js).not.toContain('alert(');
    }
  });

  it('se ve si el saldo está activo o a cero, sin «Me voy» y si el local lo permite; principal sin Face ID que activar', () => {
    const js = script(renderWalletPage('tok-1', 'es', state(), { topUp }));
    expect(js).toContain("usable=(s.status==='ACTIVE'||(s.status==='DEPLETED'&&!s.merged))&&!s.refund&&!s.closeRequested");
    expect(js).toContain('can=usable&&TU.allowed');
    expect(js).toContain("$('faceCard').hidden&&!C.paid?'btn':'btn alt'");
    expect(js).toContain('topRender(s);}');
    expect(renderWalletPage('tok-1', 'es', state(), { topUp })).toContain('\\"allowed\\":true');
  });

  it('el local no deja (pausa, formas de cobro…) → sin botón y con un aviso', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp: { ...topUp, allowed: false, block: 'paused' } });
    expect(html).toContain('\\"block\\":\\"paused\\"');
    expect(script(html)).toContain("TU.block==='blocked'?T.topUpBlocked:T.topUpOff");
    expect(html).toContain('Ahora no se puede recargar desde el móvil');
  });

  it('sin opciones de recarga (no se pudo saber) → no sale el botón', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toContain('\\"topUp\\":null');
    expect(script(html)).toContain('TU=C.topUp||{allowed:false');
  });

  it('con Face ID se pide antes de crear la recarga; una clave por intento (doble toque = la misma recarga)', () => {
    const js = script(renderWalletPage('tok-1', 'es', state({ hasFaceId: true }), { topUp }));
    expect(js).toContain('S.hasFaceId?pkGet(');
    expect(js).toContain('body={amountCents:c,key:TK,lang:C.lang}');
    expect(js).toContain('crypto.getRandomValues(a)');
    // Nueva clave al abrir, tras un error y al volver atrás desde el pago.
    expect(js.match(/newKey\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('«Pagado» de la recarga al volver a /w', () => {
  const topUp = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 };
  const now = new Date('2026-10-19T23:41:12Z');
  const paid = { payToken: 'pay-1', amountCents: 5000, authorizedAt: '2026-10-19T23:41:00Z', code: '7F2' };

  it('debajo del saldo: «Pagado», cuánto, hace cuánto, la hora que corre, el código y el justificante', () => {
    const html = renderWalletPage('tok-1', 'es', state({ balanceCents: 17_000 }), { topUp, paid, now });
    expect(html.indexOf('id="proof"')).toBeGreaterThan(html.indexOf('id="balance"'));
    expect(html.indexOf('id="proof"')).toBeLessThan(html.indexOf('id="topupBox"'));
    expect(html).toContain('<section class="proof" id="proof"');
    expect(html).toContain('aria-live="polite">Pagado</h2>');
    expect(html).toMatch(/Recarga de 50,00\s€/);
    expect(html).toContain('hace 0:12');
    expect(html).toContain('<b class="num">7F2</b>');
    expect(html).toContain('href="/pay/pay-1/receipt?lang=es"');
    expect(html).toMatch(/170,00\s€/);
    const js = script(html);
    expect(js).toContain("npPaid(document.getElementById('proof')");
    expect(js).toContain("history.replaceState(null,'',C.base+'?lang='+C.lang)");
    expect(() => new Function(js)).not.toThrow();
  });

  it('hace rato → «Ya pagado» en gris (una captura vieja no cuela)', () => {
    const later = new Date('2026-10-19T23:59:00Z');
    const html = renderWalletPage('tok-1', 'es', state(), { topUp, paid, now: later });
    expect(html).toContain('<section class="proof stale" id="proof"');
    expect(html).toContain('No es un pago nuevo.');
  });

  it('con Google Wallet: el botón justo debajo del «Pagado» (y una sola vez)', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp, paid, now, googleWallet: true });
    expect(html.match(/id="gwCard"/g)).toHaveLength(1);
    expect(html.indexOf('id="gwCard"')).toBeGreaterThan(html.indexOf('id="proof"'));
    expect(html.indexOf('id="gwCard"')).toBeLessThan(html.indexOf('id="topupBox"'));
  });

  it('sin «Pagado» no hay nada de él', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    expect(html).not.toContain('id="proof"');
    expect(script(html)).not.toContain('npPaid(');
  });
});
