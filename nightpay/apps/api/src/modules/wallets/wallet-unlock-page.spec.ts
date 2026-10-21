import { describe, expect, it } from 'vitest';
import { renderWalletUnlockPage } from './wallet-unlock-page';
const script = (html: string) => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
describe('pantalla de consulta protegida', () => {
  it('no contiene datos del cliente, inputs del PIN, ni peticiones de registro de llave', () => {
    const html = renderWalletUnlockPage('/w/card/test-card-token', 'es');
    expect(html).toContain('Face ID, huella o el código de tu teléfono');
    expect(html).toContain('No lo escribas en esta página');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('balanceCents');
    expect(html).not.toContain('movements');
    expect(script(html)).not.toContain('pkCreate(C.base');
    expect(html).toContain('noindex,nofollow');
    expect(() => new Function(script(html))).not.toThrow();
  });
  it('cubre cancelación, navegador incompatible y destinos que no sean nuestros', () => {
    const html = renderWalletUnlockPage('/w/private-token', 'en');
    expect(html).toContain('First time?');
    expect(html).toContain('pkCancelled(err)');
    expect(html).toContain('dest.origin!==window.location.origin');
    expect(html).toContain("parts[1]!=='w'");
    expect(html).toContain("if(!prepared){b.disabled=true");
    expect(() => new Function(script(html))).not.toThrow();
  });
  it('escapa la configuración y solo conserva referencias de pago válidas', () => {
    const html = renderWalletUnlockPage('/w/</script><script>bad()', 'es', 'validPaymentToken12345');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('validPaymentToken12345');
    expect(renderWalletUnlockPage('/w/token', 'es', 'https://evil.example')).not.toContain('https://evil.example');
    expect(() => new Function(script(html))).not.toThrow();
  });
});
