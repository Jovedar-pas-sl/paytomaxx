import { describe, it, expect } from 'vitest';
import { renderWalletPage } from './wallet-page';
import { SCAN_JS } from './wallet-scan';
import { WALLET_TEXT } from './wallet-text';
import type { ClientWalletState } from './wallet-charges.service';

function state(o: Partial<ClientWalletState> = {}): ClientWalletState {
  return {
    code: 'K7Q-4M2',
    balanceCents: 20_000,
    status: 'ACTIVE',
    closeRequested: false,
    hasFaceId: false,
    hasPin: false,
    hasCard: false,
    fichaNumber: null,
    venueName: null,
    merged: false,
    refund: null,
    cards: ['4242'],
    movements: [],
    ...o,
  };
}

const script = (html: string): string => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
/** El HTML de una vista (de su etiqueta a la de la siguiente). */
const between = (html: string, from: string, to: string): string => html.slice(html.indexOf(from), html.indexOf(to));
const payView = (html: string): string => between(html, 'id="viewPay"', 'id="viewTop"');
const topView = (html: string): string => between(html, 'id="viewTop"', 'id="more"');
const BACKSLASH = String.fromCharCode(92);

const topUp = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 };

describe('página del saldo del cliente', () => {
  it('lleva el estado inicial, el idioma y las rutas del saldo', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<title>Tu saldo</title>');
    // El selector de idioma arriba (español por defecto, los cuatro idiomas).
    expect(html).toContain('<details class="lang" id="langMenu">');
    expect(html).toContain('aria-current="true">Español</a>');
    expect(html).toContain('\\"base\\":\\"/w/tok-1\\"');
    expect(html).toContain('K7Q-4M2');
    expect(html).toContain('noindex');
  });

  it('los movimientos del API (recargas, devoluciones) en el idioma de la página; lo pedido, tal cual', () => {
    const js = script(renderWalletPage('tok-1', 'fr', state()));
    expect(js).toContain('a.textContent=m.labelKey&&T.mv[m.labelKey]?T.mv[m.labelKey]:m.label;');
    expect(js).toContain('Remboursé en espèces');
  });

  it('en inglés', () => {
    const html = renderWalletPage('tok-1', 'en', state());
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Your balance</title>');
    expect(html).toContain('>Pay</button>');
    expect(html).toContain('Scan the QR the staff show you');
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

  it('sin QR del código (ya no se paga enseñándolo); con "Activar Face ID" y JS válido sin barras invertidas', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      for (const options of [{}, { topUp, googleWallet: true }]) {
        const html = renderWalletPage('tok-1', lang, state(), options);
        expect(html).not.toContain('class="qr"');
        expect(html).toContain('id="faceCard"');
        expect(() => new Function(script(html))).not.toThrow();
        // El JS escrito a mano (la configuración va aparte, en JSON).
        const js = script(html);
        const page = js.slice(js.indexOf('function $(id)'), js.indexOf('})();'));
        expect(page.length).toBeGreaterThan(2000);
        expect(page.includes(BACKSLASH)).toBe(false);
      }
    }
    const es = renderWalletPage('tok-1', 'es', state());
    expect(es).toContain('Activar Face ID');
    expect(es).toContain('Solo quien desbloquee este móvil puede gastar tu saldo');
    // El primer Face ID ya no va por el enlace del saldo (M-2): solo por la vía del móvil que pagó.
    expect(script(es)).toContain("pkCreate(C.payer+'/passkey/options')");
    expect(script(es)).not.toContain("C.base+'/passkey");
  });

  it('sin Face ID (M-2): activarlo o elegir el primer PIN solo por la vía del móvil que pagó la recarga (/pay/<cobro>); si no, el QR de recepción', () => {
    const none = renderWalletPage('tok-1', 'es', state());
    expect(none).toContain('\\"payer\\":null');
    const js = script(none);
    // Sin esa vía: sin botón ni «Elegir un PIN», y dice que pida el QR de activación.
    expect(js).toContain("$('faceOn').hidden=!C.payer;$('faceWhy').textContent=C.payer?T.payFaceWhy:T.activateAtReception;");
    expect(js).toContain("$('pinOpen').hidden=!(active&&!r&&!s.hasPin&&(s.hasFaceId||C.payer));");
    expect(js).toContain("show('codeHint',s.hasPin?T.codeWithPin:s.hasFaceId||C.payer?T.codeNoPin:'')");
    expect(WALLET_TEXT.es.activateAtReception).toBe('Para activar el pago con tu móvil o elegir tu PIN, pide en recepción el QR de activación.');
    // Con ella: activar y el PIN van a /pay/<cobro> (su cookie del pago); si el navegador no es el que pagó, se quita.
    const payer = renderWalletPage('tok-1', 'es', state(), { payer: '/pay/cobro-1' });
    expect(payer).toContain('\\"payer\\":\\"/pay/cobro-1\\"');
    const pjs = script(payer);
    expect(pjs).toContain("pkPost(C.payer+'/passkey',{response:k})");
    expect(pjs).toContain("pkPost(C.payer+'/pin',{pin:a,pin2:c})");
    expect(pjs).toContain("function notPayer(e){if(!e||e.code!=='PAYER_ONLY')return false;C.payer=null;");
    // Activado: a desbloquear para ver el saldo (su sesión).
    expect(pjs).toContain("window.location.replace(C.base+'?lang='+C.lang)");
  });

  it('ya no hay cobros que aceptar o rechazar aquí: se paga con el QR de la chica o con el PIN', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
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
    expect(html).toMatch(/<p class="balance num" id="balance" aria-live="polite">200\s€<\/p>/);
  });

  it('sin confirm() ni alert(): «Me voy», PIN y sumar se hacen en hojas dentro de la página', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const html = renderWalletPage('tok-1', lang, state());
      const js = script(html);
      expect(js).not.toContain('confirm(');
      expect(js).not.toContain('alert(');
      for (const id of ['leaveSheet', 'pinSheet', 'mergeSheet']) expect(html).toContain(`<dialog class="sheet" id="${id}"`);
      expect(js).toContain('showModal');
    }
  });

  it('«Me voy»: cuánto, cómo (tarjeta ••4242 o efectivo) y en qué paso (Pedido → Aprobado → Devuelto)', () => {
    const html = renderWalletPage(
      'tok-1',
      'es',
      state({ closeRequested: true, refund: { stage: 'requested', amountCents: 20_000, methods: [] } }),
    );
    expect(html).toContain('id="refundCard"');
    expect(html).toContain('<li data-i="0">Pedido</li><li data-i="1">Aprobado</li><li data-i="2">Devuelto</li>');
    expect(html).toContain('te lo devuelve el local a tu tarjeta {cards}');
    expect(html).toContain('\\"cards\\":[\\"4242\\"]');
    expect(script(html)).toContain("'••'+c");
    expect(script(html)).toContain("aria-current','step'");
    // El seguimiento va debajo del saldo, antes de las opciones.
    expect(html.indexOf('id="refundCard"')).toBeLessThan(html.indexOf('id="seg"'));
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

  it('al momento (H-1): escucha los avisos de su saldo y ya no pregunta cada 3 s; la franja «Reconectando…» (M-7)', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const html = renderWalletPage('tok-1', lang, state());
      const js = script(html);
      expect(js).toContain('function npLive(o)');
      expect(js).toContain('LV=npLive({base:C.base');
      expect(js).toContain('LV.start();');
      // Nada de setInterval cada 3 s.
      expect(js).not.toContain('setInterval(');
      expect(js).not.toMatch(/,3000\)/);
      // La franja, debajo del saldo, y sus textos.
      expect(html).toContain('<p class="live" id="liveBar" role="status" hidden></p>');
      expect(html.indexOf('id="liveBar"')).toBeGreaterThan(html.indexOf('id="balance"'));
      expect(js).toContain(JSON.stringify(WALLET_TEXT[lang].reconnecting).slice(1, -1));
    }
    expect(WALLET_TEXT.es.reconnecting).toBe('Reconectando…');
    // 401 → al desbloqueo (como antes); 404 → «este enlace ya no vale».
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain("unauth:function(){busy=true;document.body.textContent=T.unlockWaiting;window.location.replace(C.base+'?lang='+C.lang);}");
    expect(js).toContain("gone:function(){busy=true;show('notice',T.linkGone);}");
  });
});

describe('dos opciones debajo del saldo: «Pagar» y «Recargar»', () => {
  it('dos pestañas iguales (botones de verdad, role="tab", cada una con su vista) entre el saldo y las vistas', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    expect(html).toContain('<div class="seg" role="tablist" id="seg" aria-label="¿Qué quieres hacer?" hidden>');
    expect(html).toMatch(/<button class="segb" type="button" role="tab" id="tabPay" aria-controls="viewPay" aria-selected="true">.*Pagar<\/button>/);
    expect(html).toMatch(
      /<button class="segb" type="button" role="tab" id="tabTop" aria-controls="viewTop" aria-selected="false" tabindex="-1">.*Recargar<\/button>/,
    );
    expect(html).toContain('<section class="view" id="viewPay" aria-labelledby="tabPay">');
    expect(html).toContain('<section class="view" id="viewTop" aria-labelledby="tabTop" hidden>');
    const order = ['id="balance"', 'id="seg"', 'id="viewPay"', 'id="viewTop"', 'id="more"'].map((id) => html.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Las dos con el mismo estilo de botón grande; la marcada, en crema (como
    // las maquetas: el lima queda para el botón principal).
    expect(html).toContain('.segb[aria-selected=true]{border-color:var(--fg);background:var(--fg);color:var(--ink-0)}');
    expect(html).toContain('.segb:focus-visible{outline:3px solid var(--fg)');
  });

  it('«Pagar» de entrada; una vista a la vez; flechas, Inicio y Fin cambian de pestaña', () => {
    const js = script(renderWalletPage('tok-1', 'es', state(), { topUp }));
    expect(js).toContain("var view=C.paid?'top':'pay';");
    expect(js).toContain("$('viewPay').hidden=!pay;$('viewTop').hidden=pay;");
    expect(js).toContain("$('tabPay').setAttribute('aria-selected',String(pay));$('tabTop').setAttribute('aria-selected',String(!pay));");
    expect(js).toContain("$('tabPay').tabIndex=pay?0:-1;$('tabTop').tabIndex=pay?-1:0;");
    expect(js).toContain("k==='ArrowLeft'||k==='ArrowRight'");
    expect(js).toContain("k==='Home'?'pay':k==='End'?'top'");
    // Al cambiar a «Recargar», la cámara se apaga y la recarga empieza con clave nueva.
    expect(js).toContain('if(!pay){if(SC.on)scanStop();topOpen();}');
  });

  it('sin poder recargar en este local: sin las opciones, solo «Pagar»', () => {
    for (const options of [{}, { topUp: { ...topUp, allowed: false, block: 'method-off' as const } }]) {
      const js = script(renderWalletPage('tok-1', 'es', state(), options));
      expect(js).toContain('segShow(can||C.paid);');
      expect(js).toContain("$('seg').hidden=!on;");
      // Sin pestañas, las vistas no se anuncian como paneles y se vuelve a «Pagar».
      expect(js).toContain("if(on)$(id).setAttribute('role','tabpanel');else $(id).removeAttribute('role');");
      expect(js).toContain("if(!on&&view==='top')setView('pay')");
    }
  });

  it('saldo a cero con la recarga a mano: entra en «Recargar» (en «Pagar», que recargue)', () => {
    const html = renderWalletPage('tok-1', 'es', state({ status: 'DEPLETED', balanceCents: 0 }), { topUp });
    expect(script(html)).toContain("if(!C.paid&&S.status==='DEPLETED'&&topCan(S))view='top';");
    expect(payView(html)).toContain('No te queda saldo. Recarga para volver a pagar.');
    expect(script(html)).toContain("$('payEmpty').hidden=!(can&&s.status==='DEPLETED');");
  });
});

describe('«Pagar»: solo lo de pagar', () => {
  it('el QR del personal, el desbloqueo, «Sin móvil» con el código y Google Wallet; nada de recargar', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp, googleWallet: true });
    const pay = payView(html);
    for (const id of ['payCard', 'faceCard', 'scanArea', 'scanGo', 'scanAlt', 'howCard', 'codeCard', 'gwCard']) {
      expect(pay).toContain(`id="${id}"`);
    }
    expect(pay).toContain('<h2 id="payTitle">Escanea el QR que te enseña el personal</h2>');
    expect(pay).toContain('>Escanear QR</button>');
    expect(pay).toContain('<h2 class="sub" id="codeTitle">Sin móvil: dile tu código y pon tu PIN</h2>');
    expect(pay).toContain('<p class="code num" id="code">K7Q-4M2</p>');
    expect(pay).not.toContain('topup');
    expect(pay).not.toContain('Recargar');
    expect(pay).not.toContain('id="pinOpen"');
  });

  it('con el desbloqueo activado se escanea; sin él, se activa primero; sin poder usarlo aquí, el PIN', () => {
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain('var setup=payable&&!s.hasFaceId&&canKey,scan=payable&&s.hasFaceId&&canKey;');
    expect(js).toContain("$('faceCard').hidden=!setup;$('scanArea').hidden=!scan;");
    expect(js).toContain("$('payTitle').textContent=setup?U.title:T.scanTitle;");
    // Sin poder activarlo aquí ni la vía del que pagó: el QR de activación de recepción (M-2).
    expect(js).toContain("show('howText',payable&&!canKey?(s.hasFaceId?T.faceIdNeeded:C.payer?T.unlockUnsupported:T.activateAtReception):'');");
    expect(js).toContain("$('faceDone').textContent=scan?'✓ '+U.done+' '+T.payFaceDone:'';");
  });

  it('«Sin móvil»: con PIN, que lo teclee; sin PIN, que lo elija en «Más»; con ficha, que la acerque', () => {
    const js = script(renderWalletPage('tok-1', 'es', state({ hasCard: true })));
    // Sin PIN: que lo elija en «Más» si puede (Face ID o el móvil que pagó); si no, nada aquí: la
    // tarjeta de pagar ya dice que pida el QR de activación en recepción (M-2), sin repetirlo.
    expect(js).toContain("show('codeHint',s.hasPin?T.codeWithPin:s.hasFaceId||C.payer?T.codeNoPin:'');$('fichaHint').hidden=!s.hasCard;");
    const html = renderWalletPage('tok-1', 'es', state({ hasCard: true }));
    expect(html).toContain('<p class="small" id="fichaHint" hidden>Con tu ficha: acércala al móvil del personal y pon tu PIN.</p>');
    expect(html).toContain('\\"hasCard\\":true');
    expect(renderWalletPage('tok-1', 'en', state())).toContain('With your NFC tag: hold it to the staff phone and enter your PIN.');
  });

  it('el saldo cerrado, a cero o con «Me voy» no enseña cómo pagar', () => {
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain('var canKey=pkSupported(),payable=active&&!r;');
    expect(js).toContain("$('codeCard').hidden=!active;");
  });
});

describe('«Escanear QR» dentro de la página', () => {
  const chargePath = (origin: string): ((raw: unknown) => string | null) => {
    const head = SCAN_JS.slice(0, SCAN_JS.indexOf('function scanAvail'));
    return new Function('location', 'window', 'navigator', `${head}return chargePath;`)({ origin }, {}, {}) as (
      raw: unknown,
    ) => string | null;
  };
  const TOKEN = 'Ab3_-xY9Ab3_-xY9Ab3_-xY9Ab3_-xY9';

  it('solo va a una página de cobro nuestra: /s/<token> de este mismo dominio', () => {
    const go = chargePath('https://api.paytomaxx.com');
    expect(go(`https://api.paytomaxx.com/s/${TOKEN}`)).toBe(`/s/${TOKEN}`);
    expect(go(`  https://api.paytomaxx.com/s/${TOKEN}/ `)).toBe(`/s/${TOKEN}`);
    expect(go(`https://api.paytomaxx.com/s/${TOKEN}?lang=en`)).toBe(`/s/${TOKEN}`);
    // Otro dominio, otra ruta, un token raro o algo que no es un enlace: nada.
    expect(go(`https://evil.example/s/${TOKEN}`)).toBeNull();
    expect(go(`http://api.paytomaxx.com/s/${TOKEN}`)).toBeNull();
    expect(go(`https://api.paytomaxx.com/w/${TOKEN}`)).toBeNull();
    expect(go(`https://api.paytomaxx.com/c/${TOKEN}`)).toBeNull();
    expect(go(`https://api.paytomaxx.com/s/${TOKEN}/pay`)).toBeNull();
    expect(go(`https://api.paytomaxx.com/x/s/${TOKEN}`)).toBeNull();
    expect(go('https://api.paytomaxx.com/s/corto')).toBeNull();
    expect(go('https://api.paytomaxx.com/s/<script>alert(1)</script>xxxxxxxx')).toBeNull();
    expect(go(`javascript:alert(1)//s/${TOKEN}`)).toBeNull();
    expect(go('K7Q-4M2')).toBeNull();
    expect(go(null)).toBeNull();
  });

  it('con BarcodeDetector, la cámara en la página; sin él (iPhone), sin botón: que use la cámara del móvil', () => {
    const js = script(renderWalletPage('tok-1', 'es', state({ hasFaceId: true })));
    expect(js).toContain("var scanOk=typeof window.BarcodeDetector==='function'&&!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);");
    expect(js).toContain("function scanAvail(){$('scanGo').hidden=!scanOk||SC.on;$('scanAlt').hidden=scanOk;}");
    expect(js).toContain("f.indexOf('qr_code')<0");
    expect(js).toContain("new window.BarcodeDetector({formats:['qr_code']})");
    expect(js).toContain("facingMode:{ideal:'environment'}");
    const html = renderWalletPage('tok-1', 'es', state({ hasFaceId: true }));
    expect(html).toContain('<button class="btn" type="button" id="scanGo" hidden>Escanear QR</button>');
    expect(html).toContain('<p class="how" id="scanAlt" hidden>Abre la cámara del móvil y apunta al QR del personal.</p>');
  });

  it('un QR que no es nuestro se ignora con un aviso; el nuestro abre el cobro en el idioma de la página', () => {
    const js = script(renderWalletPage('tok-1', 'es', state({ hasFaceId: true })));
    expect(js).toContain("if(to){scanStop();show('scanMsg',T.scanOpening);location.href=to+'?lang='+C.lang;return;}");
    expect(js).toContain("show('scanMsg',T.scanWrong)");
    expect(js).toContain("e&&e.name==='NotAllowedError'?T.scanDenied:T.scanFailed");
    expect(WALLET_TEXT.es.scanWrong).toBe('Ese QR no sirve para pagar con tu saldo. Apunta al QR que te enseña el personal.');
  });

  it('la cámara se apaga al cerrar, al esconder la página o al salir de ella', () => {
    expect(SCAN_JS).toContain('SC.stream.getTracks().forEach(function(k){k.stop();})');
    expect(SCAN_JS).toContain("document.addEventListener('visibilitychange',function(){if(document.visibilityState!=='visible'&&SC.on)scanStop();});");
    expect(SCAN_JS).toContain("window.addEventListener('pagehide'");
    expect(SCAN_JS.includes(BACKSLASH)).toBe(false);
  });
});

describe('«Más»: debajo de las dos vistas', () => {
  it('elegir PIN, juntar saldos, «Me voy» y los movimientos, con sus rutas en /w', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    const more = html.slice(html.indexOf('id="more"'), html.indexOf('</main>'));
    expect(more).toContain('<h2 class="kick" id="moreTitle">Más</h2>');
    for (const id of ['pinOpen', 'mergeOpen', 'leaveOpen', 'movOpen', 'movements']) expect(more).toContain(`id="${id}"`);
    expect(more).toContain('Elegir un PIN');
    expect(more).toContain('Juntar saldos');
    expect(more).toContain('Me voy: devolver mi saldo');
    // Los movimientos se ven de entrada (maqueta 5.1); se pueden plegar.
    expect(more).toContain('<button class="row" type="button" id="movOpen" aria-expanded="true" aria-controls="movBox">Movimientos');
    expect(more).toContain('<div id="movBox"><ul id="movements"></ul></div>');
    const js = script(html);
    expect(js).toContain("b.setAttribute('aria-expanded',String(open));$('movBox').hidden=!open;");
    expect(js).toContain("withKey('/pin',{pin:a,pin2:c})");
    // Con Face ID, PIN y «Me voy» piden desbloquear el móvil (reto de /pin/challenge o /close/challenge).
    expect(js).toContain("pkGet(C.base+path+'/challenge')");
    expect(js).toContain('if(S.hasFaceId&&!pkSupported()){show(\'pinErr\',T.faceIdNeeded);return;}');
    expect(js).toContain("pkGet(C.base+'/merge/challenge')");
    // El enlace no prueba que el saldo sea suyo: el móvil que pagó (C.payer, con su cookie) o su PIN.
    expect(js).toContain("post('/merge',{response:k,pin:pin})");
    expect(js).toContain("pkPost(C.payer+'/merge',{response:k})");
    expect(js).toContain("s.balanceCents>0&&(C.payer||s.hasPin)");
    expect(html).toContain('id="mergePin"');
    // Abre la hoja de sumar si viene del «Pagado» de la recarga.
    expect(js).toContain("location.hash==='#sumar'");
  });
});

describe('«Añadir a Google Wallet» en «Pagar»', () => {
  it('sin Google Wallet configurado no hay botón ni código para él', () => {
    for (const html of [renderWalletPage('tok-1', 'es', state()), renderWalletPage('tok-1', 'es', state(), { googleWallet: false })]) {
      expect(html).not.toContain('id="gwCard"');
      expect(html).not.toContain('google-wallet');
      expect(script(html)).not.toContain("post('/google-wallet')");
      expect(html).toContain('\\"gw\\":false');
    }
  });

  it('configurado: el botón OFICIAL desde nuestro dominio, en «Pagar» (debajo de «Sin móvil»)', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { googleWallet: true });
    expect(html).toContain('<img src="/w/assets/google-wallet/es" width="298" height="50" alt="Añadir a Google Wallet">');
    expect(payView(html)).toContain('id="gwCard"');
    expect(html.indexOf('id="gwCard"')).toBeGreaterThan(html.indexOf('id="codeCard"'));
    // Sale escondida: el JS la enseña solo en Android.
    expect(html).toContain('<section class="gw" id="gwCard" hidden');
    const en = renderWalletPage('tok-1', 'en', state(), { googleWallet: true });
    expect(en).toContain('<img src="/w/assets/google-wallet/en" width="283" height="50" alt="Add to Google Wallet">');
  });

  it('solo en Android, con el saldo activo, sin devolución en curso y sin sumar a otro', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const js = script(renderWalletPage('tok-1', lang, state(), { googleWallet: true }));
      expect(js).toContain("if(gw)gw.hidden=!(P==='android'&&active&&!r&&!s.merged);");
      expect(js).toContain("var gw=C.gw?$('gwCard'):null;");
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
  });
});

describe('«Recargar»: solo lo de recargar', () => {
  it('20 / 50 / 100 €, «Otra» y los límites en la vista (sin hoja); 50 € marcada; nada de pagar', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    const top = topView(html);
    expect(top).toContain('<section class="card topup" id="topupBox" hidden aria-labelledby="topupTitle">');
    expect(top).toContain('<form id="topupForm"');
    expect(html).not.toContain('id="topupSheet"');
    expect(top).toMatch(/value="2000"><span class="num">20\s€<\/span>/);
    expect(top).toMatch(/value="5000" checked><span class="num">50\s€<\/span>/);
    expect(top).toMatch(/value="10000"><span class="num">100\s€<\/span>/);
    expect(top).toContain('id="amtOther"');
    expect(top).toMatch(/De 10\s€ a 300\s€\./);
    expect(top).toContain('Apple Pay, Google Pay o tarjeta');
    expect(top).toContain('Sin propina: solo pagas lo que recargas.');
    for (const id of ['codeCard', 'payCard', 'scanGo', 'gwCard', 'pinOpen']) expect(top).not.toContain(`id="${id}"`);
    const en = renderWalletPage('tok-1', 'en', state(), { topUp });
    expect(topView(en)).toContain('Top up your balance');
    expect(topView(en)).toContain('From €10 to €300.');
  });

  it('JS válido, sin barras invertidas, y solo va a nuestra página de pago', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const js = script(renderWalletPage('tok-1', lang, state(), { topUp, googleWallet: true }));
      expect(() => new Function(js)).not.toThrow();
      const top = js.slice(js.indexOf('var TU='), js.indexOf('render(S);'));
      expect(top.length).toBeGreaterThan(500);
      expect(top.includes(BACKSLASH)).toBe(false);
      expect(js).toContain("post('/topup',body)");
      expect(js).toContain("pkGet(C.base+'/topup/challenge')");
      expect(js).toContain("u.indexOf('/pay/')===0");
      expect(js).not.toContain('confirm(');
      expect(js).not.toContain('alert(');
    }
  });

  it('se puede si el saldo está activo o a cero, sin «Me voy» y si el local lo permite', () => {
    const js = script(renderWalletPage('tok-1', 'es', state(), { topUp }));
    expect(js).toContain("function topUsable(s){return (s.status==='ACTIVE'||(s.status==='DEPLETED'&&!s.merged))&&!s.refund&&!s.closeRequested;}");
    expect(js).toContain('function topCan(s){return topUsable(s)&&TU.allowed;}');
    expect(js).toContain("$('topupBox').hidden=!can;");
    expect(js).toContain('var can=topRender(s);');
    expect(renderWalletPage('tok-1', 'es', state(), { topUp })).toContain('\\"allowed\\":true');
  });

  it('el local no deja (pausa, formas de cobro…) → sin «Recargar» y con un aviso debajo del saldo', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp: { ...topUp, allowed: false, block: 'paused' } });
    expect(html).toContain('\\"block\\":\\"paused\\"');
    expect(script(html)).toContain("TU.block==='blocked'?T.topUpBlocked:T.topUpOff");
    expect(html).toContain('Ahora no se puede recargar desde el móvil');
    expect(html.indexOf('id="topupOff"')).toBeGreaterThan(html.indexOf('id="balance"'));
    expect(html.indexOf('id="topupOff"')).toBeLessThan(html.indexOf('id="seg"'));
  });

  it('sin opciones de recarga (no se pudo saber) → no hay «Recargar»', () => {
    const html = renderWalletPage('tok-1', 'es', state());
    expect(html).toContain('\\"topUp\\":null');
    expect(script(html)).toContain('TU=C.topUp||{allowed:false');
  });

  it('con Face ID se pide antes de crear la recarga; una clave por intento (doble toque = la misma recarga)', () => {
    const js = script(renderWalletPage('tok-1', 'es', state({ hasFaceId: true }), { topUp }));
    expect(js).toContain('S.hasFaceId?pkGet(');
    expect(js).toContain('body={amountCents:c,key:TK,lang:C.lang}');
    expect(js).toContain('crypto.getRandomValues(a)');
    // Nueva clave al cargar la página, al entrar en «Recargar», tras un error y al volver atrás desde el pago.
    expect(js.match(/newKey\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(js).toContain("function topOpen(){if(busy)return;newKey();show('topupErr','');show('topupKey',S.hasFaceId?T.topUpFaceId:'');topUpd();}");
  });
});

describe('«Pagado» de la recarga al volver a /w', () => {
  const now = new Date('2026-10-19T23:41:12Z');
  const paid = { payToken: 'pay-1', amountCents: 5000, authorizedAt: '2026-10-19T23:41:00Z', code: '7F2' };

  it('se abre en «Recargar»: «Pagado», cuánto, hace cuánto, la hora que corre, el código y el justificante', () => {
    const html = renderWalletPage('tok-1', 'es', state({ balanceCents: 17_000 }), { topUp, paid, now });
    const top = topView(html);
    expect(top).toContain('<section class="proof" id="proof"');
    expect(top.indexOf('id="proof"')).toBeLessThan(top.indexOf('id="topupBox"'));
    expect(top).toContain('aria-live="polite">Pagado</h2>');
    expect(top).toMatch(/Recarga de 50\s€/);
    expect(top).toContain('hace 0:12');
    expect(top).toContain('<b class="num">7F2</b>');
    expect(top).toContain('href="/pay/pay-1/receipt?lang=es"');
    expect(html).toMatch(/170\s€/);
    const js = script(html);
    expect(js).toContain('\\"paid\\":true');
    expect(js).toContain("var view=C.paid?'top':'pay';");
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

  it('con Google Wallet: el botón sigue en «Pagar» (y una sola vez)', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp, paid, now, googleWallet: true });
    expect(html.match(/id="gwCard"/g)).toHaveLength(1);
    expect(payView(html)).toContain('id="gwCard"');
  });

  it('sin «Pagado» no hay nada de él', () => {
    const html = renderWalletPage('tok-1', 'es', state(), { topUp });
    expect(html).not.toContain('id="proof"');
    expect(script(html)).not.toContain('npPaid(');
  });
});

describe('textos de la página del saldo', () => {
  it('los dos idiomas tienen los mismos textos, ninguno vacío', () => {
    const keys = (o: object): string[] => Object.keys(o).sort();
    expect(keys(WALLET_TEXT.en)).toEqual(keys(WALLET_TEXT.es));
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      for (const [k, v] of Object.entries(WALLET_TEXT[lang])) {
        if (typeof v === 'string') expect(v.trim(), `${lang}.${k}`).not.toBe('');
      }
    }
  });
});

describe('maqueta 5.1: tarjeta OxioCard y movimientos con su referencia', () => {
  it('la tarjeta lleva el local, el saldo, el código y el número del NFC', () => {
    const html = renderWalletPage('tok-1', 'es', state({ venueName: 'Sala Medianoche', hasCard: true, fichaNumber: '0417' }));
    expect(html).toContain('<p id="balanceLabel">Tu saldo · Sala Medianoche</p>');
    expect(html).toContain('<span class="num" id="heroCode">K7Q-4M2</span><span id="heroFicha">Ficha nº 0417</span>');
    const en = renderWalletPage('tok-1', 'en', state({ venueName: 'Sala <b>', hasCard: true, fichaNumber: '0417' }));
    expect(en).toContain('Your balance · Sala &lt;b&gt;');
    expect(en).toContain('NFC tag no. 0417');
    // Sin NFC no hay número; sin local, «Saldo».
    const bare = renderWalletPage('tok-1', 'es', state({ fichaNumber: '0417' }));
    expect(bare).toContain('<span id="heroFicha"></span>');
    expect(bare).toContain('<p id="balanceLabel">Saldo</p>');
  });

  it('cada movimiento: color de su sección, concepto y debajo referencia, local y hora (todo con textContent)', () => {
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain("sw.className=m.color?'sw':'sw hold'");
    expect(js).toContain("sw.style.setProperty('--c',m.color)");
    expect(js).toContain('sub.textContent=[m.ref,m.venueName,when(m.at)].filter(Boolean).join');
    expect(js).not.toContain('innerHTML');
  });
});

describe('5.2 «He perdido mi NFC»', () => {
  it('botón rojo y hoja con Face ID, ES/EN; el JS sin barras invertidas', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const t = WALLET_TEXT[lang];
      const html = renderWalletPage('tok-1', lang, state({ hasCard: true, hasFaceId: true }));
      expect(html).toContain(`<button class="btn redo" type="button" id="lostOpen" hidden>`);
      expect(html).toContain(t.lostButton);
      expect(html).toContain('<dialog class="sheet" id="lostSheet" aria-labelledby="lostTitle">');
      expect(html).toContain(t.lostTitle);
      expect(html).toContain(t.lostGo);
      expect(html).toContain(t.lostKeep);
      const js = script(html);
      expect(js.slice(js.indexOf('function $(id)')).includes(BACKSLASH)).toBe(false);
      expect(() => new Function(js)).not.toThrow();
    }
    expect(WALLET_TEXT.es.lostTitle).toBe('¿Bloquear tu NFC?');
    expect(WALLET_TEXT.en.lostButton).toBe('I lost my NFC tag');
  });

  it('solo con NFC y Face ID en un saldo vivo; confirma con la passkey en /lost-nfc y pinta el saldo sin NFC', () => {
    const js = script(renderWalletPage('tok-1', 'es', state()));
    expect(js).toContain("var can=s.hasCard&&!s.merged&&!s.refund&&(s.status==='ACTIVE'||s.status==='DEPLETED');$('lostOpen').hidden=!(can&&s.hasFaceId);$('lostAsk').hidden=!(can&&!s.hasFaceId);");
    // Sin Face ID no hay botón, pero sí qué hacer.
    expect(renderWalletPage('tok-1', 'es', state())).toContain('¿Has perdido tu NFC? Avisa en el local');
    expect(js).toContain(' lostRender(s);');
    expect(js).toContain("pkGet(C.base+'/lost-nfc/challenge').then(function(k){return post('/lost-nfc',{response:k});})");
    expect(js).toContain("render(s);closeSheet($('lostSheet'));toast(T.lostDone);");
    // El saldo no se pierde: importe y código en la hoja.
    expect(js).toContain("fill(fill(T.lostSafe,'amount',eur(S.balanceCents)),'code',S.code)");
    expect(WALLET_TEXT.es.lostSafe).toBe('Tus {amount} no se pierden. En recepción te dan un NFC nuevo con tu código {code}.');
  });
});
