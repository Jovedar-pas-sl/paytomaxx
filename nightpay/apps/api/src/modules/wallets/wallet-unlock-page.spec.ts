import { describe, expect, it } from 'vitest';
import { renderWalletUnlockPage } from './wallet-unlock-page';
const script = (html: string) => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
const BACKSLASH = String.fromCharCode(92);

describe('pantalla de consulta protegida', () => {
  it('no contiene datos del cliente, inputs del PIN, ni peticiones de registro de llave', () => {
    const html = renderWalletUnlockPage('/w/card/test-card-token', 'es', { kind: 'locked', codeHint: 'K7Q-•••' });
    expect(html).toContain('Face ID, huella o el código de tu teléfono');
    expect(html).toContain('No lo escribas en esta página');
    expect(html).toContain('K7Q-•••');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('balanceCents');
    expect(html).not.toContain('movements');
    expect(script(html)).not.toContain('pkCreate(C.base');
    // El JS escrito a mano (la configuración va aparte, en JSON escapado).
    const js = script(html);
    expect(js.slice(js.indexOf('busy=false;') + 11).includes(BACKSLASH)).toBe(false);
    expect(html).toContain('noindex,nofollow');
    expect(() => new Function(script(html))).not.toThrow();
  });
  it('cubre cancelación, navegador incompatible y destinos que no sean nuestros', () => {
    const html = renderWalletUnlockPage('/w/private-token', 'en');
    expect(html).toContain('New phone?');
    expect(html).toContain('View my balance');
    expect(html).toContain('pkCancelled(err)');
    expect(html).toContain('dest.origin!==window.location.origin');
    expect(html).toContain("parts[1]!=='w'");
    expect(html).toContain("if(!prepared){b.disabled=true");
    expect(() => new Function(script(html))).not.toThrow();
  });
  it('escapa la configuración y solo conserva referencias de pago válidas (también en el cambio de idioma)', () => {
    const html = renderWalletUnlockPage('/w/</script><script>bad()', 'es', { kind: 'locked', paidToken: 'validPaymentToken12345' });
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('validPaymentToken12345');
    expect(html).toContain('?lang=en&amp;pagado=validPaymentToken12345');
    const evil = renderWalletUnlockPage('/w/token', 'es', { kind: 'locked', paidToken: 'https://evil.example' });
    expect(evil).not.toContain('https://evil.example');
    expect(() => new Function(script(html))).not.toThrow();
  });
  it('sin passkey: cómo activarla en recepción, con el código tapado, sin botón ni script (ES/EN)', () => {
    const es = renderWalletUnlockPage('/w/card/t', 'es', { kind: 'setup', codeHint: 'K7Q-•••' });
    expect(es).toContain('Activa tu saldo en el móvil');
    expect(es).toContain('Para ver tu saldo en tu móvil, pide en recepción el QR de activación.');
    expect(es).toContain('K7Q-•••');
    expect(es).toContain('class="ocard off"');
    const en = renderWalletUnlockPage('/w/card/t', 'en', { kind: 'setup', codeHint: 'K7Q-•••' });
    expect(en).toContain('To see your balance on your phone, ask reception for the activation QR.');
    for (const html of [es, en]) {
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('Ver mi saldo');
    }
  });
  it('NFC bloqueado o no activo: lo dice y no ofrece nada que falle', () => {
    const blocked = renderWalletUnlockPage('/w/card/t', 'es', { kind: 'blocked' });
    expect(blocked).toContain('Este NFC está bloqueado');
    expect(blocked).toContain('tu saldo sigue a salvo');
    expect(renderWalletUnlockPage('/w/card/t', 'en', { kind: 'blocked' })).toContain('This NFC is blocked');
    const off = renderWalletUnlockPage('/w/card/t', 'es', { kind: 'unavailable' });
    expect(off).toContain('Este NFC no está activo');
    for (const html of [blocked, off]) {
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('class="ocard');
    }
  });
  it('idioma: enlace al otro idioma en la barra de arriba', () => {
    expect(renderWalletUnlockPage('/w/card/t', 'es', { kind: 'setup' })).toContain('href="/w/card/t?lang=en"');
    expect(renderWalletUnlockPage('/w/card/t', 'en', { kind: 'unavailable' })).toContain('href="/w/card/t?lang=es"');
  });
});
