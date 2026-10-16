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
