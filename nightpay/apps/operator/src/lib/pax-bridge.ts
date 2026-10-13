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
 * Respuesta: { ok: true, result? , transactions? } | { ok: false, error, message? }
 * (`result` es el resultado de Paytef tal cual: approved, authorisationCode,
 * paytefOperationNumber, cardInformation…)
 */

export type BridgeMethod = 'startSale' | 'cancel' | 'lastResult' | 'voidSale' | 'shiftList';

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
  | { ok: true; result?: PaytefResult; transactions?: unknown[] }
  | { ok: false; error: string; message?: string };

interface NativeBridge {
  startSale(json: string): void;
  cancel(json: string): void;
  lastResult(json: string): void;
  voidSale(json: string): void;
  shiftList(json: string): void;
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
const DEFAULT_TIMEOUT_MS = 30_000;

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

export function callReader(method: BridgeMethod, data: Record<string, unknown> = {}): Promise<BridgeResponse> {
  if (typeof window === 'undefined') return Promise.resolve({ ok: false, error: 'noReader' });
  if (!window.NightPayPax) {
    return simulatorOn()
      ? simulate(method, data)
      : Promise.resolve({ ok: false, error: 'noReader', message: 'Esta pantalla cobra desde la app del datáfono.' });
  }
  ensureCallback();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = method === 'startSale' ? SALE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: 'timeout', message: 'El lector no responde.' });
    }, timeoutMs);
    pending.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    window.NightPayPax![method](JSON.stringify({ requestId, ...data }));
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
    return { ok: true };
  });
}
