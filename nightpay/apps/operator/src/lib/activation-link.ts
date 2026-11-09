// QR de activación (CARGADO, 4.4): un enlace de activación de UN SOLO USO
// (/w/a/<token>, 10 min) para que el cliente que recargó en efectivo active
// Face ID (o elija su PIN) en su móvil. Nunca el enlace permanente del saldo
// (M-2): quien fotografiara la pantalla se quedaba con el saldo. Lo da el API
// solo a recepción, recién hecha la recarga aquí y si aún no tiene Face ID
// (POST /v1/reception/wallets/:id/activation-link; si no, 404 y no sale nada).
// Cada petición emite uno nuevo y anula el anterior sin usar.

import { authedFetch } from './api';

export interface ActivationLink {
  url: string;
  expiresAt: string;
}

/** Solo /w/a/<token> (el token, base64url como los del API): ni /w/<enlace> ni sus acciones. */
const ACTIVATION_PATH = /^\/w\/a\/[A-Za-z0-9_-]{16,128}$/;

/**
 * null: no toca (404), o no se pudo; nunca rompe CARGADO. `read`: la ficha que
 * se acaba de leer (un saldo que ya tenía dinero, sin PIN, la pide).
 */
export async function fetchActivationLink(
  walletId: string,
  read?: { card: string; uid: string | null } | null,
): Promise<ActivationLink | null> {
  try {
    const res = await authedFetch(`/v1/reception/wallets/${encodeURIComponent(walletId)}/activation-link`, {
      method: 'POST',
      ...(read ? { body: JSON.stringify({ card: read.card, ...(read.uid ? { uid: read.uid } : {}) }) } : {}),
    });
    if (!res.ok) return null;
    return activationLinkOf(await res.json());
  } catch {
    return null;
  }
}

/**
 * Solo un enlace http(s) de activación (/w/a/<token>) que aún no ha caducado.
 * El enlace del saldo (/w/<enlace>, que mandaba un API de antes) no se enseña.
 */
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
  if (!/^https?:$/.test(parsed.protocol) || !ACTIVATION_PATH.test(parsed.pathname) || parsed.search || parsed.hash) return null;
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(until) || until <= now) return null;
  return { url, expiresAt };
}
