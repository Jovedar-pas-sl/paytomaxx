// Cliente API minimal para el web-client.
// El cliente movil no se autentica — solo usa endpoints publicos via qrToken.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export type Provider = 'WIPAY' | 'PEANPE' | 'STRIPE';

export interface PublicPaymentView {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  venueName: string;
  terminalLabel: string;
  qrExpiresAt: string;
  /** Pasarela activa para esta venue. Null si aun no asignado. */
  provider?: Provider | null;
  /** Solo para STRIPE — client_secret del PaymentIntent ya creado. */
  stripeClientSecret?: string | null;
  /** Solo para STRIPE — pk_test_... o pk_live_... para inicializar Stripe.js. */
  stripePublishableKey?: string | null;
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
