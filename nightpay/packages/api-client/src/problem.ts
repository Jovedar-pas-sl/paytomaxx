// Cuerpos de error del API (RFC 7807 ProblemDetails) → mensaje y código.

import { ApiError, LoginCodeRequiredError, TotpError, isTotpErrorCode } from './errors';

export interface ProblemInfo {
  /** El texto para enseñar; null si el API no explica nada útil. */
  readonly message: string | null;
  readonly code: string | null;
}

/** Más largo que esto, un texto plano no es un mensaje (es una página o un volcado). */
const MAX_PLAIN_TEXT = 300;

/**
 * userMessage / detail / message / title (en ese orden) y `code`. Una lista
 * (errores de validación) se une. Un texto plano corto vale; una página HTML
 * de un proxy (502…) no.
 */
export function parseProblemDetails(text: string): ProblemInfo {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const plain = text.trim();
    const readable = plain !== '' && !plain.startsWith('<') && plain.length <= MAX_PLAIN_TEXT;
    return { message: readable ? plain : null, code: null };
  }
  if (!json || typeof json !== 'object') return { message: null, code: null };
  const body = json as Record<string, unknown>;
  const raw = body.userMessage ?? body.detail ?? body.message ?? body.title;
  const code = typeof body.code === 'string' ? body.code : null;
  if (typeof raw === 'string' && raw.trim() !== '') return { message: raw, code };
  if (Array.isArray(raw) && raw.length > 0) return { message: raw.map(String).join(' · '), code };
  return { message: null, code };
}

/**
 * La respuesta de error → ApiError (o TotpError con los códigos TOTP_*).
 * `fallback` da el texto cuando el API no explica nada.
 */
export async function readApiError(
  res: Response,
  fallback: (status: number) => string = (status) => `Error ${status}`,
): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  const { message, code } = parseProblemDetails(text);
  const shown = message ?? fallback(res.status);
  const ticket = code === 'TOTP_REQUIRED' ? loginTicketOf(text) : null;
  if (ticket) return new LoginCodeRequiredError(shown, res.status, ticket.loginTicket, ticket.expiresIn);
  if (isTotpErrorCode(code)) return new TotpError(shown, res.status, code);
  return new ApiError(shown, res.status, code);
}

/** El ticket del login en dos pasos (401 TOTP_REQUIRED con `loginTicket`), si lo trae. */
export function loginTicketOf(text: string): { loginTicket: string; expiresIn: number } | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown> | null;
    if (!body || typeof body.loginTicket !== 'string' || body.loginTicket === '') return null;
    const expiresIn = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 300;
    return { loginTicket: body.loginTicket, expiresIn };
  } catch {
    return null;
  }
}
