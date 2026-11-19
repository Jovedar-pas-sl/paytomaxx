// «Pantalla del cliente»: la tablet de la barra que mira al cliente.
//  - La app del personal (su sesión): emparejar, desemparejar y decirle qué
//    cobro enseñar (Esperando y la recarga de recepción).
//  - La tablet (/pantalla): sin usuario; se identifica con su credencial
//    (Authorization: Pantalla …), que se obtiene una vez con el código. Solo
//    actúa sobre el cobro activo de su camarero: la propina que elige el
//    cliente y pagarlo con su ficha (y su PIN).

import { PracticeBlockedError, isPractice } from './practice';
import { parseProblemDetails } from '@nightpay/api-client';
import {
  CUSTOMER_DISPLAY_AUTH_SCHEME,
  type CustomerDisplayCode,
  type CustomerDisplayFichaResult,
  type CustomerDisplayPairResult,
  type CustomerDisplayStatus,
  type CustomerScreenView,
} from '@nightpay/contracts';
import { authedFetch } from './api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const TOKEN_KEY = 'np_pantalla_token';
const NO_CONNECTION_TEXT = 'Sin conexión con OxioPay. Revisa el wifi.';
const BAD_CODE_TEXT = 'Código no válido o caducado. Pide otro en el móvil del camarero.';
const TOO_MANY_TEXT = 'Demasiados intentos. Espera unos minutos.';

/** Error del API con su código HTTP (0 = sin conexión; 401 en la tablet = desemparejada). */
export class DisplayApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DisplayApiError';
    this.status = status;
  }
}

async function errorOf(res: Response, fallback: string): Promise<DisplayApiError> {
  const text = await res.text().catch(() => '');
  const { message } = parseProblemDetails(text);
  return new DisplayApiError(message ?? fallback, res.status);
}

// ─── App del personal ────────────────────────────────────────────────

/** Un cobro que enseña (o deja de enseñar) la pantalla: el de tarjeta y/o el del saldo. */
export interface DisplayTarget {
  paymentId?: string | null;
  chargeId?: string | null;
}

async function staffCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, { cache: 'no-store', ...init });
  if (!res.ok) throw await errorOf(res, 'No se ha podido. Vuelve a intentarlo.');
  return (await res.json()) as T;
}

export const fetchDisplayStatus = (): Promise<CustomerDisplayStatus> => staffCall('/v1/customer-display');

export const createDisplayCode = (): Promise<CustomerDisplayCode> =>
  staffCall('/v1/customer-display/pairing-code', { method: 'POST' });

export const unpairDisplayFromStaff = (): Promise<{ ok: true }> => staffCall('/v1/customer-display', { method: 'DELETE' });

const targetBody = (t: DisplayTarget): string => JSON.stringify({ paymentId: t.paymentId ?? null, chargeId: t.chargeId ?? null });

/** Enseñar este cobro (sin pantalla emparejada, el API no hace nada y dice paired: false). */
export const showOnDisplay = (t: DisplayTarget): Promise<CustomerDisplayStatus> =>
  staffCall('/v1/customer-display/current', { method: 'PUT', body: targetBody(t) });

/** Ya no se está en ese cobro (solo si sigue siendo el que enseña). */
export const clearDisplay = (t: DisplayTarget): Promise<{ ok: true }> =>
  staffCall('/v1/customer-display/current/clear', { method: 'POST', body: targetBody(t) });

// ─── La tablet ───────────────────────────────────────────────────────

export function getDisplayToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveDisplayToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Sin almacenamiento (modo privado): vale mientras la página siga abierta.
  }
  memoryToken = token;
}

/** Sin almacenamiento, la credencial vive en la página. */
let memoryToken: string | null = null;

export function currentDisplayToken(): string | null {
  return getDisplayToken() ?? memoryToken;
}

export function forgetDisplayToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nada que borrar
  }
}

export async function pairDisplay(code: string): Promise<CustomerDisplayPairResult> {
  if (isPractice()) throw new PracticeBlockedError('emparejar la pantalla');
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/customer-display/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
  } catch {
    throw new DisplayApiError(NO_CONNECTION_TEXT, 0);
  }
  if (res.status === 429) throw new DisplayApiError(TOO_MANY_TEXT, 429);
  if (res.status === 404 || res.status === 400) throw new DisplayApiError(BAD_CODE_TEXT, res.status);
  if (!res.ok) throw await errorOf(res, NO_CONNECTION_TEXT);
  const result = (await res.json()) as CustomerDisplayPairResult;
  saveDisplayToken(result.token);
  return result;
}

async function displayCall<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  // En práctica la tablet del cliente real no se toca (ni se lee ni se escribe).
  if (isPractice()) throw new PracticeBlockedError('la pantalla del cliente');
  const token = currentDisplayToken();
  if (!token) throw new DisplayApiError('Pantalla sin emparejar', 401);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `${CUSTOMER_DISPLAY_AUTH_SCHEME} ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new DisplayApiError(NO_CONNECTION_TEXT, 0);
  }
  if (!res.ok) throw await errorOf(res, NO_CONNECTION_TEXT);
  return (await res.json()) as T;
}

export const fetchScreen = (signal?: AbortSignal): Promise<CustomerScreenView> =>
  displayCall('/v1/customer-display/screen', {}, signal);

const postJson = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** El cliente elige la propina (0 = «Sin propina»): lo que enseña la pantalla después. */
export const setScreenTip = (key: string, tipCents: number): Promise<CustomerScreenView> =>
  displayCall('/v1/customer-display/tip', postJson({ key, tipCents }));

/** La ficha acercada a la tablet paga el cobro activo (o pide su PIN). */
export const payScreenFicha = (key: string, card: string, uid: string | null): Promise<CustomerDisplayFichaResult> =>
  displayCall('/v1/customer-display/ficha', postJson({ key, card, uid }));

/** Con su PIN, tecleado en la tablet (y la propina de la pantalla del PIN). */
export const payScreenFichaPin = (
  key: string,
  ficha: { card: string; uid: string | null },
  pin: string,
  tipCents: number | null,
): Promise<CustomerDisplayFichaResult> =>
  displayCall('/v1/customer-display/ficha/pin', postJson({ key, ...ficha, pin, tipCents }));

/** Desde la tablet: fuera la credencial (aunque el API no conteste, aquí se olvida). */
export async function unpairThisDisplay(): Promise<void> {
  try {
    await displayCall('/v1/customer-display/unpair', { method: 'POST' });
  } finally {
    forgetDisplayToken();
  }
}
