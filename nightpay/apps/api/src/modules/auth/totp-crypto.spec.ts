import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSealedTotpSecret, openTotpSecret, sealTotpSecret } from './totp-crypto';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * Lo mismo que hace `pnpm cli enroll-totp` (packages/db/scripts/cli.ts), escrito
 * a mano con node:crypto: si alguien cambia el formato en un lado y no en el
 * otro, este test falla.
 */
function sealLikeCli(secretBase32: string, kek: string): string {
  const key = createHmac('sha256', kek).update('nightpay:totp-secret:v1').digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('tv1'));
  const enc = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return ['tv1', nonce.toString('base64url'), enc.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
}

describe('secreto 2FA cifrado en la base', () => {
  it('se guarda cifrado (tv1:...), distinto cada vez, y se recupera con la misma clave', () => {
    const a = sealTotpSecret(SECRET, KEK);
    const b = sealTotpSecret(SECRET, KEK);
    expect(a).toMatch(/^tv1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toContain(SECRET);
    expect(a).not.toBe(b);
    expect(openTotpSecret(a, KEK)).toEqual({ secret: SECRET, legacy: false });
  });

  it('lee lo que escribe el CLI (mismo formato)', () => {
    expect(openTotpSecret(sealLikeCli(SECRET, KEK), KEK)).toEqual({ secret: SECRET, legacy: false });
  });

  it('un secreto antiguo en claro se acepta tal cual y se marca como antiguo', () => {
    expect(isSealedTotpSecret(SECRET)).toBe(false);
    expect(openTotpSecret(SECRET, KEK)).toEqual({ secret: SECRET, legacy: true });
    // Para leer uno antiguo no hace falta la clave.
    expect(openTotpSecret(SECRET, undefined)).toEqual({ secret: SECRET, legacy: true });
  });

  it('con otra clave o manipulado, falla (no devuelve basura)', () => {
    const sealed = sealTotpSecret(SECRET, KEK);
    expect(() => openTotpSecret(sealed, `${KEK}-otra`)).toThrow();
    const [prefix, nonce, enc, tag] = sealed.split(':');
    const flipped = `${enc!.startsWith('A') ? 'B' : 'A'}${enc!.slice(1)}`;
    expect(() => openTotpSecret([prefix, nonce, flipped, tag].join(':'), KEK)).toThrow();
    // Etiqueta recortada (GCM con tag corto): no se acepta.
    expect(() => openTotpSecret([prefix, nonce, enc, tag!.slice(0, 6)].join(':'), KEK)).toThrow();
  });

  it('sin ENCRYPTION_KEK no cifra ni descifra', () => {
    expect(() => sealTotpSecret(SECRET, undefined)).toThrow(/ENCRYPTION_KEK/);
    expect(() => openTotpSecret(sealTotpSecret(SECRET, KEK), '')).toThrow(/ENCRYPTION_KEK/);
  });
});
