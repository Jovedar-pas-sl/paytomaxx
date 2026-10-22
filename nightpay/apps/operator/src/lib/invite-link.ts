// «Copa con invitación»: el QR de la chica lleva la app con ?invita=<token>.
// Si el camarero lo lee con la cámara del móvil, se abre otra pestaña: esa
// pestaña lo apunta aquí (localStorage) y la del cobro lo recibe al momento
// (evento «storage»). Con la app ya abierta, se lee con su propia cámara.

import { staffTokenFrom } from '@nightpay/contracts';

const KEY = 'np_invita';
/** Un QR leído vale para el cobro que se está haciendo ahora, no para otro de dentro de un rato. */
export const INVITE_FRESH_MS = 2 * 60 * 1000;

interface Stored {
  token: string;
  at: number;
}

/** Al abrir la app: si trae ?invita=, se apunta y se quita de la URL. */
export function captureInviteFromUrl(win: Pick<Window, 'location' | 'history'> = window, now = Date.now()): boolean {
  const url = new URL(win.location.href);
  const token = staffTokenFrom(url.searchParams.get('invita') ?? '');
  if (!url.searchParams.has('invita')) return false;
  url.searchParams.delete('invita');
  win.history.replaceState({}, '', url.toString());
  if (!token) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, at: now } satisfies Stored));
  } catch {
    // Sin almacenamiento: se lee con la cámara de la app o pegando el enlace.
  }
  return true;
}

/** El QR leído hace poco (y se borra: vale una vez). */
export function takePendingInvite(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const s = JSON.parse(raw) as Partial<Stored>;
    return typeof s.token === 'string' && typeof s.at === 'number' && now - s.at < INVITE_FRESH_MS ? s.token : null;
  } catch {
    return null;
  }
}

/** Cuando otra pestaña (la que abrió la cámara) apunta un QR: el token. */
export function onInviteArrived(handler: (token: string) => void): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key !== KEY || !e.newValue) return;
    const token = takePendingInvite();
    if (token) handler(token);
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
