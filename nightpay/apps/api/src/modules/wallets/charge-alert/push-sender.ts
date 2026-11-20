import * as webpush from 'web-push';
import type { WebPushSettings } from '../../../config/web-push';

/**
 * Mandar UN aviso Web Push (cifrado para ese navegador y firmado con VAPID)
 * con la librería web-push. Devuelve el código HTTP del servicio de avisos
 * (201 = entregado; 404/410 = ese navegador ya no existe); lanza solo si no
 * hubo respuesta (red, tiempo agotado). Aparte para poder probar sin red.
 */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushOptions {
  vapid: WebPushSettings;
  /** Segundos que el servicio guarda el aviso si el móvil está apagado. */
  ttlSeconds: number;
  timeoutMs: number;
}

export type PushSender = (target: PushTarget, payload: string, options: PushOptions) => Promise<{ statusCode: number }>;

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Intentos por navegador (el primero y dos reintentos cortos). */
export const PUSH_ATTEMPTS = 3;
const RETRY_DELAYS_MS: readonly number[] = [500, 2_000];
/** Fallos seguidos (sin ser «ya no existe») tras los que se deja de avisar a ese navegador. */
export const MAX_PUSH_FAILS = 5;
/** Lo que el servicio guarda el aviso con el móvil apagado: 12 h. */
export const PUSH_TTL_SECONDS = 12 * 60 * 60;
export const PUSH_TIMEOUT_MS = 5_000;

/** 'sent': entregado; 'gone': ese navegador ya no existe (404/410); 'failed': no se pudo. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/**
 * Un aviso a un navegador, con reintentos cortos (sin respuesta, 429 o 5xx;
 * otro 4xx no se arregla reintentando). Nunca lanza.
 */
export async function pushWithRetries(
  send: PushSender,
  target: PushTarget,
  payload: string,
  options: PushOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<PushOutcome> {
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 2_000);
    const status = await send(target, payload, options)
      .then((r) => r.statusCode)
      .catch(() => null);
    if (status !== null && status >= 200 && status < 300) return 'sent';
    if (status === 404 || status === 410) return 'gone';
    if (status !== null && status !== 429 && status < 500) return 'failed';
  }
  return 'failed';
}

export const webPushSender: PushSender = async (target, payload, options) => {
  try {
    const res = await webpush.sendNotification(target, payload, {
      vapidDetails: options.vapid,
      TTL: options.ttlSeconds,
      urgency: 'high',
      timeout: options.timeoutMs,
      contentEncoding: 'aes128gcm',
    });
    return { statusCode: res.statusCode };
  } catch (err) {
    // web-push lanza WebPushError con el código cuando el servicio contesta que no.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return { statusCode: status };
    throw err;
  }
};
