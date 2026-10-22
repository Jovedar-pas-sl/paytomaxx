// «Activar Face ID en su móvil» (CARGADO, 4.4): el enlace privado del saldo
// recién cargado en efectivo, para que el cliente active Face ID. Lo da el API
// solo a recepción, recién hecha la recarga aquí y si aún no tiene Face ID
// (GET /v1/reception/wallets/:id/activation-link; si no, 404 y no sale nada).

import { authedFetch } from './api';

export interface ActivationLink {
  url: string;
  expiresAt: string;
}

/** null: no toca (404), o no se pudo; nunca rompe CARGADO. */
export async function fetchActivationLink(walletId: string): Promise<ActivationLink | null> {
  try {
    const res = await authedFetch(`/v1/reception/wallets/${encodeURIComponent(walletId)}/activation-link`);
    if (!res.ok) return null;
    return activationLinkOf(await res.json());
  } catch {
    return null;
  }
}

/** Solo un enlace http(s) nuestro a la página del saldo (/w/…) que aún no ha caducado. */
export function activationLinkOf(body: unknown, now: number = Date.now()): ActivationLink | null {
  if (!body || typeof body !== 'object') return null;
  const { url, expiresAt } = body as Record<string, unknown>;
  if (typeof url !== 'string' || typeof expiresAt !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.pathname.startsWith('/w/')) return null;
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(until) || until <= now) return null;
  return { url, expiresAt };
}
