// Cliente de la API para el datáfono (pantalla /pax). No hay usuario: el
// aparato se identifica con su credencial (Authorization: Device …), que se
// obtiene una vez con el código de vinculación del panel.

import type { PaytefResult } from './pax-bridge';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const DEVICE_TOKEN_KEY = 'np_pax_device_token';
const PENDING_RESULT_KEY = 'np_pax_pending_result';

/** Error de la API con su código HTTP (401 = puede que el datáfono ya no esté vinculado). */
export class PaxApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface PaxInfo {
  terminal: { label: string; zone: string | null };
  venueName: string;
}

export interface PaxCharge {
  id: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  createdByName: string;
  zone: string | null;
  terminalLabel: string | null;
  code: string;
  forThisTerminal: boolean;
}

export type SaleOutcome =
  | { status: 'PAID'; code: string; message: string }
  | { status: 'DECLINED'; message: string }
  | { status: 'DUPLICATE'; message: string; operationNumber: string }
  | { status: 'MISMATCH'; message: string; operationNumber: string | null };

export interface ShiftSummary {
  total: number;
  matched: number;
  unmatched: Array<{ operationNumber: string; amountCents: number | null; occurredAt: string | null }>;
}

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function forgetDevice(): void {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // sin almacenamiento: nada que borrar
  }
}

async function readMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; title?: unknown };
    const msg = body.detail ?? body.message ?? body.title;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // no es JSON
  }
  if (res.status === 401) return 'Este datáfono no está vinculado. Pide un código nuevo en el panel.';
  return text || `Error ${res.status}`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getDeviceToken();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `Device ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: 'no-store' });
  // Un 401 suelto (un proxy, un corte) no desvincula: eso lo decide /me.
  if (!res.ok) throw new PaxApiError(await readMessage(res), res.status);
  return res.json() as Promise<T>;
}

export async function pairDevice(code: string): Promise<PaxInfo> {
  const res = await fetch(`${API_BASE}/v1/pos-device/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await readMessage(res));
  const out = (await res.json()) as PaxInfo & { token: string };
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, out.token);
  } catch {
    throw new Error('Este navegador no deja guardar la vinculación.');
  }
  return { terminal: out.terminal, venueName: out.venueName };
}

/** Quién soy. Si responde 401, el datáfono ya no está vinculado: se olvida. */
export async function fetchPaxInfo(): Promise<PaxInfo> {
  try {
    return await call<PaxInfo>('/v1/pos-device/me');
  } catch (err) {
    if (err instanceof PaxApiError && err.status === 401) forgetDevice();
    throw err;
  }
}

/**
 * Venta aprobada en el lector pendiente de llegar a NightPay: se guarda en el
 * aparato antes de enviarla y se borra al recibir respuesta. Si la red falla,
 * la pantalla la reenvía sola (el dinero ya está cobrado).
 */
export interface PendingResult {
  paymentId: string;
  result: PaytefResult;
  savedAt: string;
}

export function savePendingResult(paymentId: string, result: PaytefResult): void {
  try {
    const entry: PendingResult = { paymentId, result, savedAt: new Date().toISOString() };
    localStorage.setItem(PENDING_RESULT_KEY, JSON.stringify(entry));
  } catch {
    // sin almacenamiento: se envía igualmente
  }
}

export function getPendingResult(): PendingResult | null {
  try {
    const raw = localStorage.getItem(PENDING_RESULT_KEY);
    return raw ? (JSON.parse(raw) as PendingResult) : null;
  } catch {
    return null;
  }
}

export function clearPendingResult(): void {
  try {
    localStorage.removeItem(PENDING_RESULT_KEY);
  } catch {
    // nada que borrar
  }
}

/**
 * ¿Rechazo definitivo del servidor? (4xx salvo 401/408/429): reintentar no
 * cambia nada; el intento ya queda registrado en el cobro.
 */
export function isFinalRejection(err: unknown): boolean {
  return (
    err instanceof PaxApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    ![401, 408, 429].includes(err.status)
  );
}

export const fetchPaxPending = (): Promise<PaxCharge[]> => call('/v1/pos-device/pending');

export const startPaxCharge = (id: string): Promise<{ reference: string; amountCents: number; currency: string }> =>
  call(`/v1/pos-device/charges/${id}/start`, { method: 'POST', body: '{}' });

/**
 * El reenvío del resultado pendiente y el propio cobro pueden coincidir: el
 * mismo resultado (cobro + operación) se envía una sola vez a la vez.
 */
const sendingResults = new Map<string, Promise<SaleOutcome>>();
export const reportPaxResult = (id: string, result: PaytefResult): Promise<SaleOutcome> => {
  const key = `${id}:${String(result.paytefOperationNumber ?? '')}`;
  const current = sendingResults.get(key);
  if (current) return current;
  const sent = call<SaleOutcome>(`/v1/pos-device/charges/${id}/result`, {
    method: 'POST',
    body: JSON.stringify(result),
  }).finally(() => sendingResults.delete(key));
  sendingResults.set(key, sent);
  return sent;
};

export const reportPaxVoid = (
  id: string,
  body: { operationNumber: string; approved: boolean; resultText?: string },
): Promise<{ ok: true }> => call(`/v1/pos-device/charges/${id}/void`, { method: 'POST', body: JSON.stringify(body) });

export const reportPaxShift = (transactions: unknown[]): Promise<ShiftSummary> =>
  call('/v1/pos-device/shift', { method: 'POST', body: JSON.stringify({ transactions }) });
