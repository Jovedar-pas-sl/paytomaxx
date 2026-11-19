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
