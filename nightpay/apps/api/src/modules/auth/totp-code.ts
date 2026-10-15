import { HttpException, HttpStatus } from '@nestjs/common';
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
