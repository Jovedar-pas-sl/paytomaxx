import { sign, type KeyObject } from 'node:crypto';

/**
 * JWT firmados con la clave de la cuenta de servicio (RS256), sin
 * dependencias: node:crypto. Dos usos:
 *  - el enlace «Añadir a Google Wallet» (https://pay.google.com/gp/v/save/<jwt>),
 *  - el token de acceso a la API de Google (OAuth2, concesión jwt-bearer).
 * Docs: https://developers.google.com/wallet/reference/rest/v1/Jwt y
 * https://developers.google.com/identity/protocols/oauth2/service-account
 */

export const GOOGLE_WALLET_SAVE_URL = 'https://pay.google.com/gp/v/save/';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
/** Google acepta como mucho 1 h entre iat y exp en la aserción. */
const ASSERTION_TTL_SEC = 3600;

export interface JwtSigner {
  serviceAccountEmail: string;
  privateKey: KeyObject;
  privateKeyId: string | null;
}

export function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/** header.payload.firma, con RS256 (RSASSA-PKCS1-v1_5 + SHA-256). */
export function signJwt(claims: Record<string, unknown>, signer: Pick<JwtSigner, 'privateKey' | 'privateKeyId'>): string {
  const header = signer.privateKeyId
    ? { alg: 'RS256', typ: 'JWT', kid: signer.privateKeyId }
    : { alg: 'RS256', typ: 'JWT' };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input), signer.privateKey);
  return `${input}.${base64url(signature)}`;
}

/**
 * Enlace para guardar el pase. El objeto ya está creado en Google (con la
 * API), así que el JWT solo lo nombra: corto (Google recomienda < 1800
 * caracteres) y sin el enlace del saldo dentro.
 */
export function saveToWalletUrl(
  signer: JwtSigner,
  input: { objectId: string; classId: string; origins: string[] },
  now: Date = new Date(),
): string {
  const claims = {
    iss: signer.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(now.getTime() / 1000),
    origins: input.origins,
    payload: { genericObjects: [{ id: input.objectId, classId: input.classId }] },
  };
  return `${GOOGLE_WALLET_SAVE_URL}${signJwt(claims, signer)}`;
}

/** Aserción para pedir el token de acceso (OAuth2 jwt-bearer). */
export function oauthAssertion(signer: JwtSigner, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  return signJwt(
    {
      iss: signer.serviceAccountEmail,
      scope: GOOGLE_WALLET_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + ASSERTION_TTL_SEC,
    },
    signer,
  );
}
