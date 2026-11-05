import { describe, expect, it } from 'vitest';
import { CUSTOMER_TEXT } from '../payments/i18n';
import { renderActivationPage } from './wallet-activation-page';

/** /w/a/<token>: la página del QR de activación de un solo uso (M-2). */

const BASE = '/w/a/AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const ok = { state: 'ok' as const, codeHint: 'K7Q-•••', venueName: 'Sala Medianoche', hasPin: false, pinRequired: false };
const script = (html: string): string => html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const BACKSLASH = String.fromCharCode(92);

describe('página del QR de activación', () => {
  it('vigente: activar el desbloqueo del móvil (y «Prefiero un PIN»), sin el enlace del saldo ni lo que tiene', () => {
    const html = renderActivationPage(BASE, 'es', ok);
    expect(html).toContain('<title>Activa tu saldo</title>');
    expect(html).toContain('Activa tu saldo en este móvil');
    expect(html).toContain('Este enlace vale una sola vez.');
    expect(html).toContain('id="faceOn"');
    expect(html).toContain('Prefiero un PIN');
    expect(html).toContain('K7Q-•••');
    expect(html).toContain('Sala Medianoche');
    expect(html).toContain('noindex');
    // Sus acciones van a /w/a/<token>/…; nada de /w/<enlace>.
    expect(script(html)).toContain("C.base+'/passkey/options'");
    expect(script(html)).toContain("C.base+'/passkey'");
    expect(script(html)).toContain("C.base+'/pin'");
  });

  it('JS válido y sin barras invertidas (va en una plantilla de TypeScript), en los cuatro idiomas', () => {
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const html = renderActivationPage(BASE, lang, ok);
      expect(html).toContain(`<html lang="${lang}">`);
      expect(() => new Function(script(html))).not.toThrow();
      // El JS escrito a mano (la configuración va aparte, en JSON).
      const js = script(html);
      const own = js.slice(js.indexOf('function $(id)'), js.indexOf('})();'));
      expect(own.length).toBeGreaterThan(500);
      expect(own.includes(BACKSLASH)).toBe(false);
      expect(html).toContain(CUSTOMER_TEXT[lang].activation.heading);
    }
  });

  it('solo va a la página del saldo de este dominio (/w/<enlace>) y, si ya tenía PIN, avisa antes de ir', () => {
    const js = script(renderActivationPage(BASE, 'es', ok));
    expect(js).toContain("parts[1]!=='w'");
    expect(js).toContain('d.origin!==window.location.origin');
    expect(js).toContain('if(hadPin)');
    expect(renderActivationPage(BASE, 'es', ok)).toContain('Ojo: este saldo ya tenía un PIN.');
  });

  it('con PIN ya elegido: sin «Prefiero un PIN» (solo el desbloqueo del móvil)', () => {
    const html = renderActivationPage(BASE, 'es', { ...ok, hasPin: true });
    expect(html).toContain('\\"hasPin\\":true');
    expect(html).not.toContain('id="pinOwn"');
  });

  it('QR de recepción de un saldo con PIN: lo pide antes de activar, y va en las dos llamadas', () => {
    const html = renderActivationPage(BASE, 'es', { ...ok, hasPin: true, pinRequired: true });
    expect(html).toContain('id="pinOwn"');
    expect(html).toContain('Este saldo ya tiene PIN.');
    const js = script(html);
    expect(js).toContain("pkCreate(C.base+'/passkey/options',ask)");
    expect(js).toContain("Object.assign({response:k},ask)");
    // Lo ha tecleado él: no hace falta avisarle de que el saldo ya tenía PIN.
    expect(js).toContain('done(r,!C.pinRequired&&r&&r.hadPin===true)');
    expect(() => new Function(js)).not.toThrow();
  });

  it('ya usado: «Este enlace ya se ha usado. Pide otro en recepción.» (sin botones ni JS)', () => {
    const html = renderActivationPage(BASE, 'es', { state: 'used' });
    expect(html).toContain('Este enlace ya se ha usado. Pide otro en recepción.');
    expect(html).not.toContain('id="faceOn"');
    expect(html).not.toContain('passkey');
  });

  it('caducado (o anulado, o que no existe): «Este enlace ha caducado. Pide otro en recepción.»', () => {
    const html = renderActivationPage(BASE, 'es', { state: 'expired' });
    expect(html).toContain('Este enlace ha caducado. Pide otro en recepción.');
    expect(html).not.toContain('id="faceOn"');
  });

  it('en inglés, francés y portugués los mismos avisos', () => {
    expect(renderActivationPage(BASE, 'en', { state: 'used' })).toContain('This link has already been used. Ask reception for a new one.');
    expect(renderActivationPage(BASE, 'fr', { state: 'expired' })).toContain('Ce lien a expiré. Demandez-en un autre à l’accueil.');
    expect(renderActivationPage(BASE, 'pt', { state: 'expired' })).toContain('Este link expirou. Peça outro na receção.');
  });

  it('el selector de idioma se queda en este enlace; el nombre del local no puede inyectar HTML', () => {
    const html = renderActivationPage(BASE, 'es', { ...ok, venueName: '<img src=x onerror=alert(1)>' });
    expect(html).toContain(`href="${BASE}?lang=en"`);
    expect(html).not.toContain('<img src=x');
  });
});
