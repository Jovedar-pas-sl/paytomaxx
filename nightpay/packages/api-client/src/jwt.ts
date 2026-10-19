// Lo que dice un access token (sin comprobar la firma: eso lo hace el API).

export interface TokenClaims {
  readonly sub?: string;
  readonly email?: string;
  readonly role?: string;
  readonly tenantId?: string;
  readonly venueSlug?: string;
  readonly exp?: number;
}

/** Las claims de un JWT; null si no se puede leer. */
export function tokenClaims(token: string): TokenClaims | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as TokenClaims) : null;
  } catch {
    return null;
  }
}

/**
 * ¿El JWT caduca en menos de `marginMs`? Si no se puede leer, se da por
 * bueno (ya lo dirá el servidor).
 */
export function tokenExpiresSoon(token: string, now = Date.now(), marginMs = 60_000): boolean {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === 'number' && exp * 1000 - now < marginMs;
}
