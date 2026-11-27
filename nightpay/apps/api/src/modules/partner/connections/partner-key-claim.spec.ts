import { describe, it, expect } from 'vitest';
import {
  CLAIM_TTL_MS,
  claimEmail,
  claimHash,
  claimInvalidPage,
  claimKeyPage,
  claimLandingPage,
  claimUrl,
  newClaim,
  openClaim,
} from './partner-key-claim';

const KEK = 'k'.repeat(64);
const ID = '11111111-2222-3333-4444-555555555555';
const KEY = `oxp_live_${'ab12'.repeat(12)}`;
const NOW = new Date('2026-12-05T22:00:00Z');

describe('el enlace de un uso: token y clave sellada', () => {
  it('token de 32 bytes en base64url, solo su sha256 se guarda y caduca en 24 h', () => {
    const claim = newClaim(KEK, ID, KEY, NOW);
    expect(claim.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claim.hash).toBe(claimHash(claim.token));
    expect(claim.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.expiresAt.getTime() - NOW.getTime()).toBe(CLAIM_TTL_MS);
    expect(newClaim(KEK, ID, KEY, NOW).token).not.toBe(claim.token);
  });

  it('la sellada no lleva la clave y solo se abre con la misma KEK y la misma conexión', () => {
    const { sealed } = newClaim(KEK, ID, KEY, NOW);
    expect(sealed).not.toContain(KEY);
    expect(sealed).not.toContain('oxp_');
    expect(openClaim(KEK, ID, sealed)).toBe(KEY);
    expect(() => openClaim(KEK, '99999999-2222-3333-4444-555555555555', sealed)).toThrow();
    expect(() => openClaim('x'.repeat(64), ID, sealed)).toThrow();
    expect(() => openClaim(undefined, ID, sealed)).toThrow(/ENCRYPTION_KEK/);
    expect(() => newClaim(undefined, ID, KEY, NOW)).toThrow(/ENCRYPTION_KEK/);
  });

  it('el enlace va al origen público del API', () => {
    expect(claimUrl('https://api.oxiopay.example', 'tok')).toBe('https://api.oxiopay.example/partner-key/tok');
  });
});

describe('el correo y las páginas', () => {
  const evil = '<script>alert(1)</script>';

  it('el correo: asunto y texto del encargo; en el HTML, los nombres escapados', () => {
    const mail = claimEmail('Cajeros', 'Sala Centro', 'https://api.oxiopay.example/partner-key/tok');
    expect(mail.subject).toMatch(/: clave de Cajeros para Sala Centro$/);
    expect(mail.text).toContain('Sala Centro te envía la clave de Cajeros para la API de OxioPay.');
    expect(mail.text).toContain('Caduca en 24 horas y se abre una sola vez.');
    expect(claimEmail(evil, evil, 'https://x').html).not.toContain('<script>');
  });

  it('la página del GET no enseña la clave, escapa los nombres y solo envía un POST a su enlace', () => {
    const html = claimLandingPage(evil, 'Sala "Centro"', 'tok_-1');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('oxp_');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Sala &quot;Centro&quot;');
    expect(html).toContain('<form method="post" action="/partner-key/tok_-1">');
    expect(html).toContain('Solo se puede ver una vez.');
    expect(html).toContain('It can be seen only once.');
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('la página de la clave: la clave en monoespaciada, escapada, y nada de fuera', () => {
    const html = claimKeyPage(KEY);
    expect(html).toContain(`<code class="key" id="k">${KEY}</code>`);
    expect(html).toContain('Esta página no se puede volver a abrir.');
    expect(claimKeyPage(`${KEY}<b>`)).toContain(`${KEY}&lt;b&gt;`);
    for (const page of [html, claimLandingPage('A', 'B', 't'), claimInvalidPage()]) {
      expect(page).not.toMatch(/(?:src|href)=["']?https?:/i);
    }
    expect(claimInvalidPage()).toContain('Este enlace ya no vale. Pide al local que te envíe uno nuevo.');
  });
});
