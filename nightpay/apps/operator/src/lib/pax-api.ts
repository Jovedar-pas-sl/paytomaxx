// Cliente de la API para el datáfono (pantalla /pax). No hay usuario: el
// aparato se identifica con su credencial (Authorization: Device …), que se
// obtiene una vez con el código de vinculación del panel.

import { codeErrorText } from './api-codes';
import type { PaytefResult } from './pax-bridge';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const DEVICE_TOKEN_KEY = 'np_pax_device_token';
/** Ventas aprobadas pendientes de llegar a OxioPay, por cobro y operación. */
const PENDING_RESULTS_KEY = 'np_pax_pending_results';
/** La versión anterior guardaba una sola (la siguiente la pisaba): se migra al leer. */
const LEGACY_PENDING_RESULT_KEY = 'np_pax_pending_result';
/** Ventas cobradas en el lector que OxioPay no admitió (anular, revisar): el camarero las ve en /pax. */
const SALES_TO_REVIEW_KEY = 'np_pax_sales_to_review';
/** Anulaciones hechas en el lector que aún no han llegado a OxioPay. */
const PENDING_VOIDS_KEY = 'np_pax_pending_voids';
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
  /** «Pago con saldo» encendido en el local (un API antiguo no lo manda: se enseña). */
  wallet?: boolean;
  /** Ajustes de la noche del local (el teclado del PIN). Un API antiguo no los manda: los de fábrica. */
  night?: unknown;
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
  | { status: 'MISMATCH'; message: string; operationNumber: string | null }
  /** Recarga de recepción cobrada en el lector: falta que el encargado la confirme con Paytef. */
  | { status: 'PENDING'; message: string; operationNumber: string };

/** Cobrado en el lector y sin confirmar aún: nunca se ofrece cobrarlo otra vez. */
export const PENDING_CONFIRM_TEXT = 'Cobrado en el datáfono · pendiente de confirmar por el encargado. No cobres otra vez.';

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
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; title?: unknown; code?: unknown };
    const msg = body.detail ?? body.message ?? body.title;
    const known = codeErrorText(typeof body.code === 'string' ? body.code : null, typeof msg === 'string' ? msg : null);
    if (known) return known;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // no es JSON
  }
  if (res.status === 401) return 'Este datáfono no está vinculado. Pide un código nuevo en el panel.';
  return text || `Error ${res.status}`;
}

/** Petición al API con la credencial del datáfono (también la usa el cobro del saldo, pax-saldo.ts). */
export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  /** El importe del cobro (para anularla en el lector si OxioPay no la admite). Las guardadas antes no lo traen. */
  amountCents?: number;
  savedAt: string;
}

type PendingMap = Record<string, PendingResult>;

function operationOf(result: PaytefResult): string {
  return String(result.paytefOperationNumber ?? '');
}

function pendingKey(paymentId: string, result: PaytefResult): string {
  return `${paymentId}:${operationOf(result)}`;
}

/** Un mapa guardado en el aparato: ilegible o sin almacenamiento, vacío (nada que reenviar ni enseñar). */
function readStore<T>(key: string, valid: (value: unknown) => value is T): Record<string, T> {
  const map: Record<string, T> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [k, entry] of Object.entries(parsed)) if (valid(entry)) map[k] = entry;
    }
  } catch {
    // ilegible: como si no hubiera nada
  }
  return map;
}

function writeStore(key: string, map: Record<string, unknown>): boolean {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...map };
  delete rest[key];
  return rest;
}

const byAge = <T extends { savedAt: string }>(a: T, b: T): number => a.savedAt.localeCompare(b.savedAt);

function isPendingResult(value: unknown): value is PendingResult {
  const entry = value as Partial<PendingResult> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.paymentId === 'string' &&
    typeof entry.savedAt === 'string' &&
    typeof entry.result === 'object' &&
    entry.result !== null &&
    (entry.amountCents === undefined || typeof entry.amountCents === 'number')
  );
}

function writePending(map: PendingMap): boolean {
  return writeStore(PENDING_RESULTS_KEY, map);
}

function readPending(): PendingMap {
  return migrateLegacy(readStore(PENDING_RESULTS_KEY, isPendingResult));
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

export function savePendingResult(paymentId: string, result: PaytefResult, amountCents?: number): void {
  const entry: PendingResult = {
    paymentId,
    result,
    ...(amountCents === undefined ? {} : { amountCents }),
    savedAt: new Date().toISOString(),
  };
  // Sin almacenamiento: se envía igualmente.
  writePending({ ...readPending(), [pendingKey(paymentId, result)]: entry });
}

/** Las ventas aprobadas aún sin enviar, de la más antigua a la más nueva. */
export function getPendingResults(): PendingResult[] {
  return Object.values(readPending()).sort(byAge);
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
  writePending(withoutKey(map, key));
}

// ─── Ventas por revisar (A2-02, A2-03, A2-07) ─────────────────────────────

/** Lo que OxioPay contestó a una venta ya cobrada en el lector: hay que anularla. */
export const VOID_TITLE = 'Hay que anular esta operación';
/** Un rechazo definitivo (4xx) a una venta APROBADA: el dinero ya se cobró. */
export const NOT_ACCEPTED_TITLE = 'El cliente ya ha pagado en el datáfono, pero OxioPay no lo ha aceptado';
/** Anulada en el lector, pero OxioPay no reconoce esa operación en el cobro. */
export const VOID_UNKNOWN_TITLE = 'Anulada en el datáfono, pero OxioPay no la tiene en este cobro: avisa al encargado';

/**
 * Una venta cobrada en el lector que OxioPay no admitió (doble cobro, otro
 * importe, un 4xx) o una anulación que no reconoce: se guarda en el aparato y
 * la lista de /pax la enseña con «Anular en el datáfono» hasta que se resuelve.
 */
export interface SaleToReview {
  /**
   * void: OxioPay pide anularla (doble cobro, no cuadra). notAccepted: aprobada
   * y rechazada del todo (4xx). voidUnknown: ya anulada en el lector, pero
   * OxioPay no tiene esa operación en el cobro (solo para avisar al encargado).
   */
  kind: 'void' | 'notAccepted' | 'voidUnknown';
  paymentId: string;
  operationNumber: string | null;
  title: string;
  message: string;
  /** Para anularla en el lector; null: no se ofrece (sin operación, o ya anulada). */
  voidable: { amountCents: number; reference: string } | null;
  savedAt: string;
}

export type SaleToReviewInput = Omit<SaleToReview, 'savedAt'>;

function reviewKey(paymentId: string, operationNumber: string | null): string {
  return `${paymentId}:${operationNumber ?? ''}`;
}

function isSaleToReview(value: unknown): value is SaleToReview {
  const e = value as Partial<SaleToReview> | null;
  if (typeof e !== 'object' || e === null) return false;
  const voidOk =
    e.voidable === null ||
    (typeof e.voidable === 'object' && typeof e.voidable?.amountCents === 'number' && typeof e.voidable?.reference === 'string');
  return (
    (e.kind === 'void' || e.kind === 'notAccepted' || e.kind === 'voidUnknown') &&
    typeof e.paymentId === 'string' &&
    typeof e.savedAt === 'string' &&
    typeof e.title === 'string' &&
    typeof e.message === 'string' &&
    (e.operationNumber === null || typeof e.operationNumber === 'string') &&
    voidOk
  );
}

/** Se guarda (o se actualiza en su sitio) una por cobro y operación. */
export function saveSaleToReview(input: SaleToReviewInput): void {
  const map = readStore(SALES_TO_REVIEW_KEY, isSaleToReview);
  const key = reviewKey(input.paymentId, input.operationNumber);
  const savedAt = map[key]?.savedAt ?? new Date().toISOString();
  writeStore(SALES_TO_REVIEW_KEY, { ...map, [key]: { ...input, savedAt } });
}

/** Las ventas por revisar, de la más antigua a la más nueva. */
export function getSalesToReview(): SaleToReview[] {
  return Object.values(readStore(SALES_TO_REVIEW_KEY, isSaleToReview)).sort(byAge);
}

/**
 * ¿Ese cobro tiene una venta cobrada en el lector sin resolver (por anular o
 * que OxioPay no aceptó)? Entonces no se vuelve a cobrar hasta resolverla: el
 * cliente pagaría dos veces. Un aviso de anulación ya hecha no lo frena.
 */
export function isChargeOnHold(paymentId: string): boolean {
  return getSalesToReview().some((r) => r.paymentId === paymentId && r.kind !== 'voidUnknown');
}

/** Resuelta (anulada y avisada, o el camarero la quita): fuera de la lista. */
export function clearSaleToReview(paymentId: string, operationNumber: string | null): void {
  const map = readStore(SALES_TO_REVIEW_KEY, isSaleToReview);
  const key = reviewKey(paymentId, operationNumber);
  if (key in map) writeStore(SALES_TO_REVIEW_KEY, withoutKey(map, key));
}

/** Una venta del lector, con lo necesario para anularla. */
type Sale = Pick<PendingResult, 'paymentId' | 'result' | 'amountCents'>;

function voidableOf(sale: Sale, operationNumber: string | null): SaleToReview['voidable'] {
  const amountCents = sale.amountCents ?? sale.result.requestedAmount ?? null;
  if (!operationNumber || amountCents === null) return null;
  return { amountCents, reference: sale.result.transactionReference ?? '' };
}

/** DUPLICATE o MISMATCH: hay que anular la operación (lo demás no se revisa). */
export function reviewOfOutcome(sale: Sale, outcome: SaleOutcome): SaleToReviewInput | null {
  if (outcome.status !== 'DUPLICATE' && outcome.status !== 'MISMATCH') return null;
  const operationNumber = outcome.operationNumber ?? null;
  return {
    kind: 'void',
    paymentId: sale.paymentId,
    operationNumber,
    title: VOID_TITLE,
    message: outcome.message,
    voidable: voidableOf(sale, operationNumber),
  };
}

/** Rechazo definitivo (4xx) a una venta aprobada: el cliente ya pagó; nunca se repite. */
export function notAcceptedReview(sale: Sale, message: string): SaleToReviewInput {
  const operationNumber = operationOf(sale.result) || null;
  return {
    kind: 'notAccepted',
    paymentId: sale.paymentId,
    operationNumber,
    title: NOT_ACCEPTED_TITLE,
    message,
    voidable: voidableOf(sale, operationNumber),
  };
}

/** Anulada en el lector y OxioPay no tiene esa operación en el cobro: solo un aviso (no se anula otra vez). */
export function voidUnknownNotice(paymentId: string, operationNumber: string, message: string): SaleToReviewInput {
  return { kind: 'voidUnknown', paymentId, operationNumber, title: VOID_UNKNOWN_TITLE, message, voidable: null };
}

/**
 * Reenvía las ventas aprobadas que no llegaron. Las que OxioPay contesta con
 * «anula esta operación» (DUPLICATE, MISMATCH) o rechaza del todo (4xx) no se
 * borran sin más: pasan a las ventas por revisar, que el camarero ve con
 * «Anular en el datáfono». A la primera que falla por red o servidor, se para
 * hasta la siguiente vuelta.
 */
export async function flushPendingResults(): Promise<void> {
  for (const entry of getPendingResults()) {
    let review: SaleToReviewInput | null;
    try {
      review = reviewOfOutcome(entry, await reportPaxResult(entry.paymentId, entry.result));
    } catch (err) {
      if (!isFinalRejection(err)) return;
      review = notAcceptedReview(entry, (err as Error).message);
    }
    // Primero a revisar y luego fuera de la cola: un corte entre medias no la pierde.
    if (review) saveSaleToReview(review);
    clearPendingResult(entry.paymentId, entry.result);
  }
}

// ─── Anulaciones sin avisar a OxioPay (A2-07) ─────────────────────────────

export interface PendingVoid {
  paymentId: string;
  operationNumber: string;
  approved: boolean;
  resultText?: string;
  savedAt: string;
}

type VoidBody = { operationNumber: string; approved: boolean; resultText?: string };

/** El aviso de una anulación: llegó, queda en cola para reenviarlo, o OxioPay no lo admite. */
export type VoidReport = 'sent' | 'queued' | 'refused';

function isPendingVoid(value: unknown): value is PendingVoid {
  const e = value as Partial<PendingVoid> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.paymentId === 'string' &&
    typeof e.operationNumber === 'string' &&
    typeof e.approved === 'boolean' &&
    typeof e.savedAt === 'string'
  );
}

function clearPendingVoid(paymentId: string, operationNumber: string): void {
  const map = readStore(PENDING_VOIDS_KEY, isPendingVoid);
  const key = reviewKey(paymentId, operationNumber);
  if (key in map) writeStore(PENDING_VOIDS_KEY, withoutKey(map, key));
}

/** Los avisos de anulación aún sin llegar, del más antiguo al más nuevo. */
export function getPendingVoids(): PendingVoid[] {
  return Object.values(readStore(PENDING_VOIDS_KEY, isPendingVoid)).sort(byAge);
}

/**
 * Avisa a OxioPay de una anulación hecha en el lector. Se guarda antes de
 * enviarla: sin red o con el servidor caído queda en cola y la lista de /pax
 * la reenvía sola; un rechazo definitivo no se reintenta.
 */
export async function sendVoid(paymentId: string, body: VoidBody): Promise<VoidReport> {
  const entry: PendingVoid = { paymentId, ...body, savedAt: new Date().toISOString() };
  const map = readStore(PENDING_VOIDS_KEY, isPendingVoid);
  writeStore(PENDING_VOIDS_KEY, { ...map, [reviewKey(paymentId, body.operationNumber)]: entry });
  try {
    await reportPaxVoid(paymentId, body);
  } catch (err) {
    if (!isFinalRejection(err)) return 'queued';
    clearPendingVoid(paymentId, body.operationNumber);
    return 'refused';
  }
  clearPendingVoid(paymentId, body.operationNumber);
  return 'sent';
}

/**
 * Reenvía los avisos de anulación en cola. Si OxioPay ya no admite uno de una
 * anulación hecha, pasa a revisar (que lo vea el camarero, sin botón de anular).
 */
export async function flushPendingVoids(): Promise<void> {
  for (const v of getPendingVoids()) {
    try {
      await reportPaxVoid(v.paymentId, {
        operationNumber: v.operationNumber,
        approved: v.approved,
        ...(v.resultText === undefined ? {} : { resultText: v.resultText }),
      });
    } catch (err) {
      if (!isFinalRejection(err)) return;
      if (v.approved) saveSaleToReview(voidUnknownNotice(v.paymentId, v.operationNumber, (err as Error).message));
    }
    clearPendingVoid(v.paymentId, v.operationNumber);
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
