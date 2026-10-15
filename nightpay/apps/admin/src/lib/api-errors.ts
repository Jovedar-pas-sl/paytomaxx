// Errores del API → mensajes en castellano para quien usa el panel.

/** Error de una llamada al API: el mensaje para enseñar y el código HTTP. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** Código de error de máquina si el API lo manda (p. ej. "DUPLICATE_REFUND"). */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const NETWORK_ERROR_MESSAGE = 'No se pudo conectar con el servidor. Revisa la conexión e inténtalo de nuevo.';

/** Mensaje genérico cuando el API no explica nada útil. */
export function genericStatusMessage(status: number): string {
  if (status >= 500) return `El servidor no responde ahora mismo (error ${status}). Prueba en un momento.`;
  if (status === 429) return 'Demasiadas peticiones seguidas. Espera un momento y vuelve a probar.';
  if (status === 404) return 'No encontrado (error 404).';
  if (status === 403) return 'Tu cuenta no tiene permiso para esto.';
  return `Error ${status}`;
}

/**
 * Cuerpo de una respuesta de error (ProblemDetails: detail / message / title)
 * → mensaje y código. Una página HTML de un proxy (502…) no se enseña tal cual.
 */
export function errorFromBody(text: string, status: number): { message: string; code: string | null } {
  try {
    const body = JSON.parse(text) as { detail?: unknown; title?: unknown; message?: unknown; code?: unknown };
    const msg = body.detail ?? body.message ?? body.title;
    const code = typeof body.code === 'string' ? body.code : null;
    if (typeof msg === 'string' && msg) return { message: msg, code };
    if (Array.isArray(msg)) return { message: msg.join(' · '), code };
  } catch {
    // no es JSON
  }
  const plain = text.trim();
  const readable = plain && !plain.startsWith('<') && plain.length <= 300;
  return { message: readable ? plain : genericStatusMessage(status), code: null };
}

/** Login fallido → qué le pasa a quien intenta entrar, según el código HTTP. */
export function loginErrorMessage(status: number, detail: string): string {
  if (status === 429 || /too many|demasiad/i.test(detail)) {
    return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
  }
  if (status === 400 || status === 401 || status === 403) return 'Email o contraseña incorrectos.';
  if (status >= 500) return 'El servidor no responde ahora mismo. Prueba en unos minutos.';
  return `No se pudo entrar (error ${status}).`;
}

const TOTP_REUSE_HINT = 'Si acabas de usar ese código, espera al siguiente (cambia cada 30 s).';

/**
 * Errores de 2FA → castellano. El API antiguo los da en inglés; el nuevo, en
 * castellano y con código (TOTP_REQUIRED / TOTP_NOT_ENROLLED / TOTP_INVALID).
 */
export function humanizeTotpError(message: string, code: string | null = null): string {
  if (/TOTP required/i.test(message)) {
    return 'Este importe pide el código de tu app de verificación (2FA).';
  }
  if (/TOTP not enrolled/i.test(message)) {
    return 'Para este importe hace falta la verificación en dos pasos: actívala en Ajustes → Verificación en dos pasos.';
  }
  if (/Invalid TOTP/i.test(message)) return `Código 2FA incorrecto o caducado. ${TOTP_REUSE_HINT}`;
  if (code === 'TOTP_INVALID' && !message.includes('30 s')) return `${message.replace(/\.$/, '')}. ${TOTP_REUSE_HINT}`;
  return message;
}

/** El API pide el código 2FA para seguir (también por lo devuelto acumulado, no solo desde 100 € de golpe). */
export function needsTotpCode(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') return true;
  return /TOTP required|pide el código de tu app|hace falta el código 2FA/i.test(err.message);
}

/** La pasarela no confirmó la devolución: queda pendiente (502 REFUND_OUTCOME_UNKNOWN). */
export function isRefundOutcomeUnknown(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'REFUND_OUTCOME_UNKNOWN';
}

const DUPLICATE_REFUND_TEXT = /ya hay una devoluci[oó]n|conf[ií]rmalo/i;

/** El API avisa de que ya hay una devolución igual en ese cobro (hay que confirmar que es otra). */
export function isDuplicateRefundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError) {
    if (err.code === 'DUPLICATE_REFUND') return true;
    if (err.status !== 409) return false;
  }
  return DUPLICATE_REFUND_TEXT.test(err.message);
}
