/**
 * Helpers para los tests E2E:
 *  - mintToken: genera un JWT válido contra el secreto del API local.
 *  - apiFetch: wrapper fetch con auth + baseURL.
 *
 * NO crea usuarios — se asume seed mínima del API. Para escenarios que necesiten
 * datos específicos, usar /v1/admin/* endpoints autenticados como OWNER.
 */
import jwt from 'jsonwebtoken';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4100';
const JWT_SECRET =
  process.env.JWT_SECRET ??
  'bf4382381f7725c21f57394a05c7487669020d2e596a9caa080b6a04b3ef0a98';

export interface MintTokenInput {
  sub: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
  tenantId: string;
  venueSlug: string;
  ttlSec?: number;
}

export function mintToken(input: MintTokenInput): string {
  return jwt.sign(
    {
      sub: input.sub,
      email: input.email,
      role: input.role,
      tenantId: input.tenantId,
      venueSlug: input.venueSlug,
    },
    JWT_SECRET,
    {
      expiresIn: input.ttlSec ?? 600,
      issuer: 'nightpay',
      audience: 'nightpay-internal',
    },
  );
}

export async function apiFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${API_URL}${path}`, { ...rest, headers });
}

export async function apiJson<T = unknown>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`apiJson ${path} → ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}
