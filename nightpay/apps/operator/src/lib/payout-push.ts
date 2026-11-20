/**
 * «Avisarme cuando me paguen»: el aviso al móvil (Web Push) cuando el local le
 * apunta un pago. Este navegador se apunta con el service worker de la app
 * (public/pago-sw.js) y la clave pública del API; sin clave, el API lo tiene
 * apagado y la app no lo ofrece.
 */
import { authedFetch, parseOperatorApiError } from './api';

export const PAYOUT_SW_URL = '/pago-sw.js';

/** Lo que hay en este móvil: no puede, hay que añadir la app (iPhone), bloqueado, apagado o encendido. */
export type PushHere = 'unsupported' | 'install' | 'denied' | 'off' | 'on';

export interface PushEnv {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  /** iPhone o iPad: Safari solo deja avisos con la app abierta desde la pantalla de inicio. */
  ios: boolean;
  /** Abierta como app (desde la pantalla de inicio). */
  standalone: boolean;
}

export function pushSupport(env: PushEnv): 'ok' | 'install' | 'unsupported' {
  if (env.serviceWorker && env.pushManager && env.notification) return 'ok';
  return env.ios && !env.standalone ? 'install' : 'unsupported';
}

function browserEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    serviceWorker: 'serviceWorker' in nav,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
    ios: /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1),
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
  };
}

/** La clave pública (base64url) como la pide pushManager.subscribe. */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** ¿La suscripción de este navegador es de esta clave? (si el dueño cambió las claves, hay que volver a apuntarse). */
export function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current || current.byteLength !== key.length) return false;
  const bytes = new Uint8Array(current);
  return key.every((b, i) => bytes[i] === b);
}

/** La clave pública del API (null: avisos apagados, o un API de antes). */
export async function fetchPushKey(): Promise<string | null> {
  const res = await authedFetch('/v1/operators/me/push');
  if (!res.ok) return null;
  const body = (await res.json()) as { publicKey?: unknown };
  return typeof body.publicKey === 'string' && body.publicKey ? body.publicKey : null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration(PAYOUT_SW_URL);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Cómo está en este móvil. */
export async function pushHere(): Promise<PushHere> {
  const support = pushSupport(browserEnv());
  if (support !== 'ok') return support;
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
}

/**
 * Lo enciende (pide el permiso) o, si ya lo estaba, lo vuelve a apuntar en el
 * API: así sigue llegando aunque el API lo hubiera borrado o cambiado la clave.
 */
export async function turnPushOn(publicKey: string): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Sin tu permiso, el móvil no puede enseñar el aviso. Puedes darlo en los ajustes del móvil.');
  }
  const reg = await navigator.serviceWorker.register(PAYOUT_SW_URL);
  await navigator.serviceWorker.ready;
  const key = vapidKeyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const res = await authedFetch('/v1/operators/me/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'El aviso'));
}

/** «Quitar el aviso»: deja de avisar a este móvil. */
export async function turnPushOff(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const res = await authedFetch('/v1/operators/me/push/off', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  // Aunque el API no conteste, sin la suscripción el servicio de avisos ya no entrega nada (y el API la borra al probar).
  await sub.unsubscribe();
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'El aviso'));
}

/** Al salir de la app: este móvil deja de avisar de los pagos de quien salió. Nunca falla. */
export async function forgetPushHere(): Promise<void> {
  try {
    await (await currentSubscription())?.unsubscribe();
  } catch {
    // Sin service worker o sin permiso: no había nada que quitar.
  }
}
