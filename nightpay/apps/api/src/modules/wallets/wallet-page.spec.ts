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

  it('el token va codificado en la ruta', () => {
    const html = renderWalletPage('a/b"c', 'es', state());
    expect(html).toContain('/w/a%2Fb%22c');
  });
});
