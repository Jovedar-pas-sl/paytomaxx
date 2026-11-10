// Ajustes → Formas de cobro → «Cargar saldo desde casa» (solo el dueño).

import type { HomeTopUpSettings } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export async function fetchHomeTopUp(): Promise<HomeTopUpSettings> {
  const res = await authedFetch('/v1/admin/venue/home-topup');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Encender (crea el enlace la primera vez) o apagar (el enlace deja de funcionar, pero se guarda). */
export async function setHomeTopUp(enabled: boolean): Promise<HomeTopUpSettings> {
  const res = await authedFetch('/v1/admin/venue/home-topup', { method: 'PATCH', body: JSON.stringify({ enabled }) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** «Enlace nuevo»: el de ahora deja de funcionar al momento. */
export async function rotateHomeTopUp(): Promise<HomeTopUpSettings> {
  const res = await authedFetch('/v1/admin/venue/home-topup/rotate', { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** El cartel de la cola de esta noche (B16): el enlace con el QR firmado, su PNG y hasta cuándo vale. */
export interface HomeTopUpQueuePoster {
  url: string;
  qrPngDataUrl: string;
  validUntil: string;
}

export async function fetchHomeTopUpQueue(): Promise<HomeTopUpQueuePoster> {
  const res = await authedFetch('/v1/admin/venue/home-topup/queue');
  if (!res.ok) throw await apiError(res);
  return res.json();
}
