// Verificación en dos pasos de quien está dentro.

import { authedFetch, totpAwareError } from '../http';

// ─── Verificación en dos pasos (2FA, app de verificación) ──────────

export interface TotpStatus {
  enabled: boolean;
}

export interface TotpSetup {
  /** otpauth://… (lo mismo que el QR). */
  otpauthUrl: string;
  /** Clave para teclearla en la app si no se puede escanear. */
  secret: string;
  /** QR en PNG como data URL. */
  qrPngDataUrl: string;
}

/** ¿Tiene activada la verificación en dos pasos quien está dentro? (404 = API sin esta función). */
export async function fetchTotpStatus(): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp');
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Empieza a activarla: secreto nuevo + QR. 409 si ya está activada. */
export async function startTotpSetup(): Promise<TotpSetup> {
  const res = await authedFetch('/v1/auth/totp/setup', { method: 'POST', body: '{}' });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Termina de activarla con el primer código de la app. */
export async function confirmTotp(code: string): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** La desactiva (pide un código válido de la app). */
export async function disableTotp(code: string): Promise<TotpStatus> {
  const res = await authedFetch('/v1/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}
