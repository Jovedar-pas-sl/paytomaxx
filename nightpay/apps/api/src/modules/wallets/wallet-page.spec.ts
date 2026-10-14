import { describe, it, expect } from 'vitest';
import { renderNoWalletPage, renderWalletPage } from './wallet-page';
import type { ClientWalletState } from './wallet-charges.service';

function state(o: Partial<ClientWalletState> = {}): ClientWalletState {
  return {
    code: 'K7Q-4M2',
    balanceCents: 20_000,
    status: 'ACTIVE',
    closeRequested: false,
    pending: null,
    movements: [],
    ...o,
  };
}

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
        pending: {
          id: 'req-1',
          amountCents: 5000,
          serviceName: '</script><img src=x onerror=alert(1)>',
          requestedByName: 'Lola',
          venueName: 'Local',
          expiresAt: new Date().toISOString(),
        },
      }),
    );
    expect(html).not.toContain('</script><img');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('enseña el QR del código; descarta cualquier cosa que no sea un <svg> limpio', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>';
    expect(renderWalletPage('tok-1', 'es', state(), { codeQrSvg: svg })).toContain(`<div class="qr" aria-hidden="true">${svg}</div>`);
    expect(renderWalletPage('tok-1', 'es', state())).not.toContain('class="qr"');
    const evil = '<svg onload="alert(1)"></svg>';
    expect(renderWalletPage('tok-1', 'es', state(), { codeQrSvg: evil })).not.toContain('onload');
    expect(renderWalletPage('tok-1', 'es', state(), { codeQrSvg: '<img src=x>' })).not.toContain('<img');
  });

  it('el token va codificado en la ruta', () => {
    const html = renderWalletPage('a/b"c', 'es', state());
    expect(html).toContain('/w/a%2Fb%22c');
  });
});

describe('móvil del cliente y Face ID / huella en la página', () => {
  const script = (html: string): string => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

  it('el script de la página es JavaScript válido (si se rompe, no funciona nada)', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderWalletPage('tok-1', lang, { ...state(), device: { thisPhone: true, otherPhone: false, protected: true } });
      expect(() => new Function(script(html))).not.toThrow();
    }
  });

  it('lleva los textos de proteger con Face ID y el aviso de "este móvil recuerda tu saldo"', () => {
    const html = renderWalletPage('tok-1', 'es', { ...state(), device: { thisPhone: true, otherPhone: false, protected: false } });
    expect(html).toContain('Activar Face ID / huella');
    expect(html).toContain('Este móvil recuerda tu saldo');
    expect(html).toContain('id="protectCard"');
    // Aceptar e irse pasan por Face ID si el saldo está protegido.
    expect(script(html)).toContain("post('/requests/'+encodeURIComponent(this.dataset.id)+'/accept',true)");
    expect(script(html)).toContain("post('/close',true)");
    expect(script(html)).toContain("post('/requests/'+encodeURIComponent(this.dataset.id)+'/reject',true)");
  });

  it('el saldo se pide para el móvil desde la página (no al abrir el enlace)', () => {
    const html = renderWalletPage('tok-1', 'es', { ...state(), device: { thisPhone: false, otherPhone: false, protected: false } });
    expect(script(html)).toContain("if(!dv.thisPhone&&!dv.otherPhone)api('/claim')");
  });

  it('/w en un móvil sin saldo: lo explica, en los dos idiomas', () => {
    expect(renderNoWalletPage('es')).toContain('En este móvil no hay ningún saldo guardado.');
    expect(renderNoWalletPage('en')).toContain('There is no balance saved on this phone.');
  });
});

