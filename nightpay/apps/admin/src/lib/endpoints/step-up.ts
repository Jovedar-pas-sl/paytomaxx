// La verificación del momento (ver lo delicado de un cobro, 5 minutos) y las
// llaves de acceso de quien está dentro (quien no tiene 2FA se verifica con su
// móvil: Face ID, huella o el PIN del teléfono).

import {
  createPasskey,
  getPasskey,
  type CreationOptionsJSON,
  type CredentialJSON,
  type RequestOptionsJSON,
} from '@nightpay/api-client';
import type { StaffPasskeyView, StepUpPasskeyResult, StepUpStatus } from '@nightpay/contracts';
import { authedFetch, totpAwareError } from '../http';

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Si está verificado ahora, hasta cuándo y con qué tiene que verificarse. */
export async function fetchStepUp(): Promise<StepUpStatus> {
  const res = await authedFetch('/v1/auth/step-up', { cache: 'no-store' });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Con el código de su 2FA: 5 minutos para ver lo delicado. */
export async function verifyStepUpWithCode(code: string): Promise<StepUpStatus> {
  const res = await authedFetch('/v1/auth/step-up/totp', json({ code }));
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/**
 * El reto para su llave. Se pide antes de que toque el botón: en el iPhone,
 * Face ID tiene que salir en el mismo toque (passkeyConfirm justo después).
 * Con `action`, para repetir esa acción (la que dice el 403 PASSKEY_REQUIRED).
 */
export async function passkeyChallenge(action?: string): Promise<RequestOptionsJSON> {
  const res = await authedFetch('/v1/auth/step-up/passkey/options', json(action ? { action } : {}));
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** En el toque: su móvil firma el reto y el API da los 5 minutos (o la prueba de la acción). */
export async function passkeyConfirm(options: RequestOptionsJSON, action?: string): Promise<StepUpPasskeyResult> {
  const response: CredentialJSON = await getPasskey(options);
  const res = await authedFetch('/v1/auth/step-up/passkey', json(action ? { response, action } : { response }));
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Sus llaves de acceso (sin la clave). */
export async function fetchPasskeys(): Promise<StaffPasskeyView[]> {
  const res = await authedFetch('/v1/auth/passkeys', { cache: 'no-store' });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Dar de alta una llave, paso 1: la contraseña (y el código, si tiene 2FA). */
export async function passkeyRegistrationOptions(password: string, totpCode?: string): Promise<CreationOptionsJSON> {
  const res = await authedFetch('/v1/auth/passkeys/options', json(totpCode ? { password, totpCode } : { password }));
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Paso 2, en el toque: el móvil crea la llave y el API la guarda. */
export async function passkeyRegister(options: CreationOptionsJSON, name?: string): Promise<StaffPasskeyView> {
  const response = await createPasskey(options);
  const res = await authedFetch('/v1/auth/passkeys', json(name ? { response, name } : { response }));
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

export async function removePasskey(id: string): Promise<void> {
  const res = await authedFetch(`/v1/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw await totpAwareError(res);
}
