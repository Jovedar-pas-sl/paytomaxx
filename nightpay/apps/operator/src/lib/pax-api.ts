// Cliente de la API para el datáfono (pantalla /pax). No hay usuario: el
// aparato se identifica con su credencial (Authorization: Device …), que se
// obtiene una vez con el código de vinculación del panel.

import type { PaytefResult } from './pax-bridge';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const DEVICE_TOKEN_KEY = 'np_pax_device_token';
/** Ventas aprobadas pendientes de llegar a OxioPay, por cobro y operación. */
const PENDING_RESULTS_KEY = 'np_pax_pending_results';
/** La versión anterior guardaba una sola (la siguiente la pisaba): se migra al leer. */
const LEGACY_PENDING_RESULT_KEY = 'np_pax_pending_result';
/** Sin respuesta del API (wifi del datáfono, servidor caído): se reintenta. */
const NO_CONNECTION_TEXT = 'Sin conexión con OxioPay. Revisa el wifi del datáfono.';

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
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: 'no-store' });
  } catch {
    // Estado 0: ni definitivo ni de vinculación; se vuelve a intentar.
    throw new PaxApiError(NO_CONNECTION_TEXT, 0);
  }
  // Un 401 suelto (un proxy, un corte) no desvincula: eso lo decide /me.
  if (!res.ok) throw new PaxApiError(await readMessage(res), res.status);
  return res.json() as Promise<T>;
}

export async function pairDevice(code: string): Promise<PaxInfo> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/pos-device/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error(NO_CONNECTION_TEXT);
  }
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
 * la pantalla la reenvía sola (el dinero ya está cobrado). Una por cobro y
 * operación: una venta nueva no pisa a otra que aún no ha llegado.
 */
export interface PendingResult {
  paymentId: string;
  result: PaytefResult;
  savedAt: string;
}

type PendingMap = Record<string, PendingResult>;

function pendingKey(paymentId: string, result: PaytefResult): string {
  return `${paymentId}:${String(result.paytefOperationNumber ?? '')}`;
}

function isPendingResult(value: unknown): value is PendingResult {
  const entry = value as Partial<PendingResult> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.paymentId === 'string' &&
    typeof entry.savedAt === 'string' &&
    typeof entry.result === 'object' &&
    entry.result !== null
  );
}

function writePending(map: PendingMap): boolean {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(PENDING_RESULTS_KEY);
    else localStorage.setItem(PENDING_RESULTS_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

function readPending(): PendingMap {
  const map: PendingMap = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_RESULTS_KEY) ?? '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, entry] of Object.entries(parsed)) if (isPendingResult(entry)) map[key] = entry;
    }
  } catch {
    // ilegible: no hay nada que se pueda reenviar
  }
  return migrateLegacy(map);
}

/** La venta que dejó la versión de un solo hueco pasa a la lista (y solo entonces se borra). */
function migrateLegacy(map: PendingMap): PendingMap {
  try {
    const raw = localStorage.getItem(LEGACY_PENDING_RESULT_KEY);
    if (!raw) return map;
    const legacy = JSON.parse(raw) as unknown;
    if (!isPendingResult(legacy)) {
      localStorage.removeItem(LEGACY_PENDING_RESULT_KEY);
      return map;
    }
    const merged = { ...map, [pendingKey(legacy.paymentId, legacy.result)]: legacy };
    if (writePending(merged)) localStorage.removeItem(LEGACY_PENDING_RESULT_KEY);
    return merged;
  } catch {
    return map;
  }
}

export function savePendingResult(paymentId: string, result: PaytefResult): void {
  const entry: PendingResult = { paymentId, result, savedAt: new Date().toISOString() };
  // Sin almacenamiento: se envía igualmente.
  writePending({ ...readPending(), [pendingKey(paymentId, result)]: entry });
}

/** Las ventas aprobadas aún sin enviar, de la más antigua a la más nueva. */
export function getPendingResults(): PendingResult[] {
  return Object.values(readPending()).sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

/** Mientras haya alguna, el datáfono no empieza otra venta. */
export function hasPendingResults(): boolean {
  return getPendingResults().length > 0;
}

/** Ya llegó (o el servidor no la admite): se borra solo esa venta. */
export function clearPendingResult(paymentId: string, result: PaytefResult): void {
  const map = readPending();
  const key = pendingKey(paymentId, result);
  if (!(key in map)) return;
  const rest = { ...map };
  delete rest[key];
  writePending(rest);
}

/**
 * Reenvía las ventas aprobadas que no llegaron. Las que el servidor ya no
 * admite se olvidan (el intento queda en el cobro); a la primera que falla
 * por red o servidor, se para hasta la siguiente vuelta.
 */
export async function flushPendingResults(): Promise<void> {
  for (const entry of getPendingResults()) {
    try {
      await reportPaxResult(entry.paymentId, entry.result);
    } catch (err) {
      if (!isFinalRejection(err)) return;
    }
    clearPendingResult(entry.paymentId, entry.result);
  }
}

/**
 * ¿La última operación del lector es la de este cobro? Sin referencia o con
 * otra, no se sabe: nunca se da por "no se cobró" (sería cobrar dos veces).
 */
export function isResultForReference(result: PaytefResult, reference: string | null): boolean {
  return Boolean(reference) && result.transactionReference === reference;
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

export const fetchPaxPending = (signal?: AbortSignal): Promise<PaxCharge[]> =>
  call('/v1/pos-device/pending', { signal });

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
