// Cliente API minimal para el web-client.
// El cliente movil no se autentica — solo usa endpoints publicos via qrToken.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

/**
 * Convierte HTTPError + body de respuesta en mensaje legible para cliente
 * borracho a las 3am. NO devolvemos detalles técnicos — solo qué hacer.
 *
 * El backend devuelve Problem-Details RFC 7807 (title/detail/status) o
 * texto crudo. Mapeamos por status code primero, luego por title.
 */
async function parseApiError(res: Response): Promise<string> {
  const status = res.status;
  let backendDetail: string | undefined;
  try {
    const text = await res.text();
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text) as { title?: string; detail?: string; message?: string };
      backendDetail = parsed.detail ?? parsed.message ?? parsed.title;
    }
  } catch {
    // Sin body parseable — usamos solo el status
  }

  // Mapeo por status: prioridad sobre el detail técnico
  if (status === 404) return 'Este cobro ya no existe. Pídele a la chica que genere uno nuevo.';
  if (status === 410 || status === 422) return 'El cobro ha caducado. Pide uno nuevo, por favor.';
  if (status === 409) return 'El cobro ya está en proceso. Espera un momento sin recargar.';
  if (status === 401 || status === 403) return 'No tienes permiso para este cobro.';
  if (status === 429) return 'Demasiados intentos. Espera 30 segundos.';
  if (status >= 500) return 'Hay un problema con el sistema. Avisa a la chica, ya estamos al tanto.';
  if (status >= 400) {
    // 4xx genérico — mostrar detail si parece humanizado, si no genérico
    if (backendDetail && backendDetail.length < 120 && !backendDetail.includes('{')) {
      return backendDetail;
    }
    return 'No se ha podido completar el cobro. Pide uno nuevo.';
  }
  return 'Algo fue mal. Pide a la chica un nuevo cobro.';
}

export interface PublicPaymentView {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  venueName: string;
  terminalLabel: string;
  qrExpiresAt: string;
}

export async function fetchPaymentByToken(token: string): Promise<PublicPaymentView> {
  const res = await fetch(`${API_BASE}/v1/payments/public/${token}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json();
}

export async function startAuthorization(
  token: string,
): Promise<{ status: string; providerTxId?: string }> {
  // Body vacio `{}` — Fastify rechaza Content-Type:application/json con body vacio.
  const res = await fetch(`${API_BASE}/v1/payments/public/${token}/start-authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json();
}

export const apiBase = API_BASE;
export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

// ─── Phase 1B — Wallet (cliente ve su balance) ─────────────────────

export interface WalletPublicView {
  id: string;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  expiresAt: string | null;
  consumptions: Array<{
    id: string;
    amountCents: number;
    category: string;
    providedByName: string | null;
    createdAt: string;
  }>;
}

export async function fetchWalletByToken(qrToken: string): Promise<WalletPublicView> {
  const res = await fetch(`${API_BASE}/v1/wallets/public/${encodeURIComponent(qrToken)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json();
}
