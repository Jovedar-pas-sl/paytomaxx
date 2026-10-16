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
      expect(script(html)).toContain("post('/close')");
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
    expect(js).toContain("post('/pin',{pin:a,pin2:c})");
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
    expect(js).toContain('busyBtn(b,true,T.sending)');
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
