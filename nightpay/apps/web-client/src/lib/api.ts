// Cliente API minimal para el web-client.
// El cliente movil no se autentica — solo usa endpoints publicos via qrToken.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
