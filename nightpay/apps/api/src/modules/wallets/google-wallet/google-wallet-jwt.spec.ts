import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WALLET_SAVE_URL,
  GOOGLE_WALLET_SCOPE,
  oauthAssertion,
  saveToWalletUrl,
  signJwt,
} from './google-wallet-jwt';

// Par de claves de la prueba: se firma con la privada y se comprueba con la pública.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SIGNER = { serviceAccountEmail: 'wallet@oxiopay.iam.gserviceaccount.com', privateKey, privateKeyId: 'kid-1' };
const NOW = new Date('2026-10-16T22:00:00Z');

function parts(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; signature: Buffer } {
  const [h, c, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')),
    input: `${h}.${c}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('JWT RS256 con node:crypto', () => {
  it('la firma se verifica con la clave pública (y no con otra)', () => {
    const jwt = signJwt({ hola: 'mundo', n: 1 }, SIGNER);
    const { header, claims, input, signature } = parts(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(claims).toEqual({ hola: 'mundo', n: 1 });
    expect(verify('sha256', Buffer.from(input), publicKey, signature)).toBe(true);
    expect(verify('sha256', Buffer.from(input), other.publicKey, signature)).toBe(false);
    // Base64url sin relleno: nada de "=", "+" ni "/".
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('sin id de clave, la cabecera no lleva "kid"', () => {
    const { header } = parts(signJwt({}, { privateKey, privateKeyId: null }));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('tocar el contenido rompe la firma', () => {
    const { input, signature } = parts(signJwt({ amount: 100 }, SIGNER));
    const forged = `${input.split('.')[0]}.${Buffer.from(JSON.stringify({ amount: 999 })).toString('base64url')}`;
    expect(verify('sha256', Buffer.from(forged), publicKey, signature)).toBe(false);
  });
});

describe('enlace «Añadir a Google Wallet»', () => {
  const objectId = '3388000000012345678.oxiopay_saldo-0123456789abcdef0123456789abcdef01234567';
  const classId = '3388000000012345678.oxiopay_saldo';

  it('https://pay.google.com/gp/v/save/<jwt> con los campos de Google y solo el id del pase', () => {
    const url = saveToWalletUrl(SIGNER, { objectId, classId, origins: ['https://api.paytomaxx.com'] }, NOW);
    expect(url.startsWith(GOOGLE_WALLET_SAVE_URL)).toBe(true);
    const { claims, input, signature } = parts(url.slice(GOOGLE_WALLET_SAVE_URL.length));
    expect(claims).toEqual({
      iss: SIGNER.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(NOW.getTime() / 1000),
      origins: ['https://api.paytomaxx.com'],
      payload: { genericObjects: [{ id: objectId, classId }] },
    });
    expect(verify('sha256', Buffer.from(input), publicKey, signature)).toBe(true);
  });

  it('corto: por debajo de los 1800 caracteres que recomienda Google', () => {
    const url = saveToWalletUrl(SIGNER, { objectId, classId, origins: ['https://api.paytomaxx.com'] }, NOW);
    expect(url.length - GOOGLE_WALLET_SAVE_URL.length).toBeLessThan(1800);
  });
});

describe('aserción OAuth2 (jwt-bearer) de la cuenta de servicio', () => {
  it('iss, scope de Wallet, aud del token de Google y 1 h como mucho', () => {
    const { claims, input, signature } = parts(oauthAssertion(SIGNER, NOW));
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(claims).toEqual({
      iss: SIGNER.serviceAccountEmail,
      scope: GOOGLE_WALLET_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    expect(GOOGLE_WALLET_SCOPE).toBe('https://www.googleapis.com/auth/wallet_object.issuer');
    expect(verify('sha256', Buffer.from(input), publicKey, signature)).toBe(true);
  });
});
