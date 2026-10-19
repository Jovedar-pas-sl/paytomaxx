/**
 * Puente con el lector de tarjetas del datáfono PAX.
 *
 * La pantalla /pax se abre dentro de la app NightPay del datáfono (Android,
 * apps/pax-android). Esa app expone `window.NightPayPax` y habla con la
 * Device API de Paytef en el propio aparato (127.0.0.1:8887). Contrato:
 *
 *   JS → app:  window.NightPayPax.<método>(JSON.stringify({ requestId, ...datos }))
 *   app → JS:  window.nightpayPaxCallback(requestId, JSON.stringify(respuesta))
 *
 * Métodos: startSale { amountCents, reference } · cancel {} · lastResult {}
 *          voidSale { operationNumber, amountCents, reference } · shiftList {}
 * Saldo (app 0.2+; las versiones viejas no los tienen → error notSupported):
 *          capabilities {}          → { nfc: 'ready'|'disabled'|'unavailable', camera }
 *          scanQr { timeoutMs }     → { text }   (cámara; error cancelled si el camarero vuelve)
 *          readNfc { timeoutMs }    → { uid, url } (ficha NTAG por NFC de Android)
 *          cancelRead {}            → corta el readNfc / writeNfc en curso
 * Recepción (app 0.3+):
 *          writeNfc { url, onlyIfBlank, timeoutMs } → { uid, url, written }
 *            graba el enlace en la ficha que acerquen (NDEF, un registro URI).
 *            Con onlyIfBlank, si ya tiene algo grabado no la toca: written
 *            false y `url` lo que tenía (null si no es un enlace).
 *            Errores: readOnly, tooSmall, writeFailed, timeout, cancelled.
 * Respuesta: { ok: true, result? , transactions?, … } | { ok: false, error, message? }
 * (`result` es el resultado de Paytef tal cual: approved, authorisationCode,
 * paytefOperationNumber, cardInformation…)
 */

export type BridgeMethod =
  | 'startSale'
  | 'cancel'
  | 'lastResult'
  | 'voidSale'
  | 'shiftList'
  | 'capabilities'
  | 'scanQr'
  | 'readNfc'
  | 'writeNfc'
  | 'cancelRead';

/** NFC de Android en el datáfono: el del A920 Pro puede estar reservado para el lector de tarjetas. */
export type NfcState = 'ready' | 'disabled' | 'unavailable';

export interface PaytefResult {
  approved: boolean;
  resultText?: string;
  authorisationCode?: string;
  paytefOperationNumber?: string | number;
  transactionReference?: string;
  requestedAmount?: number;
  [key: string]: unknown;
}

export type BridgeResponse =
  | {
      ok: true;
      result?: PaytefResult;
      transactions?: unknown[];
      /** scanQr: el texto del QR. */
      text?: string;
      /** readNfc / writeNfc: número de serie de la ficha (hex) y el enlace NDEF grabado. */
      uid?: string | null;
      url?: string | null;
      /** writeNfc: se ha grabado ahora (false: ya tenía algo y no se tocó). */
      written?: boolean;
      /** capabilities. */
      nfc?: NfcState;
      camera?: boolean;
    }
  | { ok: false; error: string; message?: string };

type NativeMethod = (json: string) => void;

interface NativeBridge {
  startSale: NativeMethod;
  cancel: NativeMethod;
  lastResult: NativeMethod;
  voidSale: NativeMethod;
  shiftList: NativeMethod;
  // Solo en la app 0.2+.
  capabilities?: NativeMethod;
  scanQr?: NativeMethod;
  readNfc?: NativeMethod;
  cancelRead?: NativeMethod;
  // Solo en la app 0.3+.
  writeNfc?: NativeMethod;
}

declare global {
  interface Window {
    NightPayPax?: NativeBridge;
    nightpayPaxCallback?: (requestId: string, json: string) => void;
  }
}

/**
 * Una venta espera al cliente. La app del datáfono se rinde a los 170 s (y
 * cancela en el lector): la web espera un poco más para recibir su respuesta.
 */
const SALE_TIMEOUT_MS = 200_000;
/** La cámara y el NFC se rinden solos antes (la app, a 90 s como mucho): la web espera algo más. */
const READ_TIMEOUT_MS = 130_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutFor(method: BridgeMethod): number {
  if (method === 'startSale') return SALE_TIMEOUT_MS;
  if (method === 'scanQr' || method === 'readNfc' || method === 'writeNfc') return READ_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

const pending = new Map<string, (r: BridgeResponse) => void>();

function ensureCallback(): void {
  if (typeof window === 'undefined' || window.nightpayPaxCallback) return;
  window.nightpayPaxCallback = (requestId, json) => {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    try {
      resolve(JSON.parse(json) as BridgeResponse);
    } catch {
      resolve({ ok: false, error: 'badResponse', message: 'Respuesta del lector ilegible' });
    }
  };
}

/** Estamos dentro de la app del datáfono (o en el simulador de pruebas). */
export function hasReader(): boolean {
  return typeof window !== 'undefined' && (Boolean(window.NightPayPax) || simulatorOn());
}

function simulatorOn(): boolean {
  return process.env.NEXT_PUBLIC_PAX_SIMULATOR === '1';
}

/** ¿La app del datáfono instalada tiene este método? (las versiones viejas no leen fichas ni QR). */
export function hasBridgeMethod(method: BridgeMethod): boolean {
  if (typeof window === 'undefined') return false;
  const native = window.NightPayPax;
  return native ? typeof native[method] === 'function' : simulatorOn();
}

export function callReader(method: BridgeMethod, data: Record<string, unknown> = {}): Promise<BridgeResponse> {
  if (typeof window === 'undefined') return Promise.resolve({ ok: false, error: 'noReader' });
  if (!window.NightPayPax) {
    return simulatorOn()
      ? simulate(method, data)
      : Promise.resolve({ ok: false, error: 'noReader', message: 'Esta pantalla cobra desde la app del datáfono.' });
  }
  if (typeof window.NightPayPax[method] !== 'function') {
    return Promise.resolve({ ok: false, error: 'notSupported', message: 'Actualiza la app OxioPay del datáfono.' });
  }
  ensureCallback();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = timeoutFor(method);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: 'timeout', message: 'El lector no responde.' });
    }, timeoutMs);
    pending.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    // Llamado como método del objeto de la app (fuera de él, Android no lo ejecuta).
    window.NightPayPax![method]!(JSON.stringify({ requestId, ...data }));
  });
}

/** Solo en pruebas (NEXT_PUBLIC_PAX_SIMULATOR=1): una venta aprobada al momento. */
function simulate(method: BridgeMethod, data: Record<string, unknown>): Promise<BridgeResponse> {
  const op = String(Math.floor(Math.random() * 1_000_000));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return wait(1200).then((): BridgeResponse => {
    if (method === 'startSale' || method === 'lastResult') {
      return {
        ok: true,
        result: {
          approved: true,
          authorisationCode: 'SIM123',
          paytefOperationNumber: op,
          transactionReference: String(data.reference ?? ''),
          requestedAmount: Number(data.amountCents ?? 0),
          cardInformation: { hiddenCardNumber: '************4242', cardTypeCode: 'VI', isContactless: true },
        },
      };
    }
    if (method === 'voidSale') return { ok: true, result: { approved: true } };
    if (method === 'shiftList') return { ok: true, transactions: [] };
    // Sin cámara ni NFC en el simulador: el saldo se prueba con el código del cliente.
    if (method === 'capabilities') return { ok: true, nfc: 'unavailable', camera: false };
    if (method === 'scanQr' || method === 'readNfc' || method === 'writeNfc') {
      return { ok: false, error: 'notSupported', message: 'Simulador sin lector' };
    }
    return { ok: true };
  });
}
