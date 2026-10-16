import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import * as speakeasy from 'speakeasy';

/** RFC 6238: un código nuevo cada 30 s. */
export const TOTP_STEP_SECONDS = 30;
/** ±1 paso (30 s antes/después): tolerancia al reloj del móvil. */
export const TOTP_WINDOW = 1;

const CODE_RE = /^\d{6}$/;

export const TOTP_MESSAGES = {
  required: 'Pon el código de tu app de verificación (2FA)',
  invalid: 'Código 2FA incorrecto o caducado',
  reused: 'Ese código 2FA ya se ha usado. Espera al siguiente (cambia cada 30 s).',
  unreadable: 'No se puede comprobar tu 2FA. Hay que volver a activarla.',
  notEnrolled: 'Activa antes la verificación en dos pasos (2FA) en tu perfil.',
} as const;

export type TotpErrorKind = keyof typeof TOTP_MESSAGES;

/**
 * Código de cada error 2FA: el panel (admin, api-errors.ts) decide con él si
 * pide el código (TOTP_REQUIRED), si añade la pista de los 30 s
 * (TOTP_INVALID, también para el código ya usado) o si manda activar la 2FA
 * (TOTP_NOT_ENROLLED). Todos los errores 2FA salen de aquí.
 */
export const TOTP_ERROR_CODES = {
  required: 'TOTP_REQUIRED',
  invalid: 'TOTP_INVALID',
  reused: 'TOTP_INVALID',
  unreadable: 'TOTP_UNREADABLE',
  notEnrolled: 'TOTP_NOT_ENROLLED',
} as const satisfies Record<TotpErrorKind, string>;

/** El 429 del bloqueo por códigos malos. */
export const TOTP_LOCKED_CODE = 'TOTP_LOCKED';

/** 403 `{ message, code }`; el texto por defecto es el de TOTP_MESSAGES. */
export function totpForbidden(kind: TotpErrorKind, message: string = TOTP_MESSAGES[kind]): ForbiddenException {
  return new ForbiddenException({ message, code: TOTP_ERROR_CODES[kind] });
}

export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** Paso de tiempo (time-step) con el que coincide el código, o null si no vale. */
export function matchTotpStep(secretBase32: string, code: string | undefined, nowMs = Date.now()): number | null {
  if (!secretBase32 || !code || !CODE_RE.test(code)) return null;
  const counter = totpStepAt(nowMs);
  const match = speakeasy.totp.verifyDelta({
    secret: secretBase32,
    encoding: 'base32',
    token: code,
    window: TOTP_WINDOW,
    counter,
  });
  return match ? counter + match.delta : null;
}

/** 429 con los minutos que quedan de bloqueo. */
export function totpLockedError(ttlSeconds: number): HttpException {
  const minutes = Math.max(1, Math.ceil(ttlSeconds / 60));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: `Demasiados códigos 2FA incorrectos. Espera ${minutes} min y vuelve a probar.`,
      code: TOTP_LOCKED_CODE,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * URL otpauth:// para el QR (formato "Key Uri" de Google Authenticator):
 * etiqueta "Emisor:cuenta" y parámetro issuer, para que la app muestre la marca.
 */
export function buildOtpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = [
    `secret=${secretBase32}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    'digits=6',
    `period=${TOTP_STEP_SECONDS}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
