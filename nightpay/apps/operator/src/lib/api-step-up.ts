// La verificación del momento (ver lo delicado de un cobro, 5 minutos) y las
// llaves de acceso de quien está dentro, desde la app del personal: quien no
// tiene 2FA se verifica con su móvil (Face ID, huella o el PIN del teléfono).

import {
  createPasskey,
  getPasskey,
  parseProblemDetails,
  type CreationOptionsJSON,
  type RequestOptionsJSON,
} from '@nightpay/api-client';
import type { StaffPasskeyView, StepUpPasskeyResult, StepUpStatus } from '@nightpay/contracts';
import { authedFetch } from './api';

/** Error del API con su código (PASSKEY_TIMEOUT, PASSWORD_INVALID…). */
export class StepUpApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = 'StepUpApiError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, { cache: 'no-store', ...init });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const { message, code } = parseProblemDetails(text);
    throw new StepUpApiError(res.status, message ?? 'No se ha podido verificar. Vuelve a intentarlo.', code);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const fetchStepUp = (): Promise<StepUpStatus> => call('/v1/auth/step-up');

export const verifyStepUpWithCode = (code: string): Promise<StepUpStatus> => call('/v1/auth/step-up/totp', post({ code }));

/** El reto para su llave: se pide antes del toque (en el iPhone, Face ID sale en el mismo toque). */
export const passkeyChallenge = (action?: string): Promise<RequestOptionsJSON> =>
  call('/v1/auth/step-up/passkey/options', post(action ? { action } : {}));

/** En el toque: su móvil firma el reto; el API da los 5 minutos (o la prueba de la acción). */
export async function passkeyConfirm(options: RequestOptionsJSON, action?: string): Promise<StepUpPasskeyResult> {
  const response = await getPasskey(options);
  return call('/v1/auth/step-up/passkey', post(action ? { response, action } : { response }));
}

export const fetchPasskeys = (): Promise<StaffPasskeyView[]> => call('/v1/auth/passkeys');

/** Dar de alta una llave, paso 1: la contraseña (y el código, si tiene 2FA). */
export const passkeyRegistrationOptions = (password: string, totpCode?: string): Promise<CreationOptionsJSON> =>
  call('/v1/auth/passkeys/options', post(totpCode ? { password, totpCode } : { password }));

/** Paso 2, en el toque: el móvil crea la llave y el API la guarda. */
export async function passkeyRegister(options: CreationOptionsJSON): Promise<StaffPasskeyView> {
  const response = await createPasskey(options);
  return call('/v1/auth/passkeys', post({ response }));
}

export const removePasskey = (id: string): Promise<void> => call(`/v1/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });

const TEXTS: Readonly<Record<string, string>> = {
  PASSKEY_NOT_SET: 'No tienes ninguna llave de acceso: dala de alta en el menú, en «Llave de acceso».',
  TOTP_REQUIRED: 'Tienes la verificación en dos pasos: usa su código.',
  PASSKEY_TIMEOUT: 'Ha tardado demasiado. Vuelve a intentarlo.',
  PASSKEY_USED: 'Esa confirmación ya se usó. Vuelve a intentarlo.',
  PASSKEY_FAILED: 'No se ha podido comprobar la llave. Vuelve a intentarlo.',
  PASSKEY_UNKNOWN: 'Esa llave no es tuya.',
  PASSKEY_LIMIT: 'Ya tienes 5 llaves: quita una antes de añadir otra.',
  PASSKEY_EXISTS: 'Esa llave ya está dada de alta.',
  PASSWORD_INVALID: 'La contraseña no es correcta.',
};

/** Qué decir de un error de la llave o de la verificación (null: canceló en el móvil, nada que decir). */
export function stepUpErrorText(err: unknown): string | null {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (err instanceof StepUpApiError && err.code && TEXTS[err.code]) return TEXTS[err.code]!;
  return err instanceof Error ? err.message : 'No se ha podido verificar. Vuelve a intentarlo.';
}
