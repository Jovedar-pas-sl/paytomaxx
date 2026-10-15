// Peticiones al API con tiempo máximo y errores en español para la cajera:
// nunca el JSON crudo del API.

/** Tiempo máximo de una petición: sin él, un cobro colgado deja el botón girando. */
const REQUEST_TIMEOUT_MS = 15_000;

export const MESSAGES = {
  network: 'No se pudo conectar con el servidor. Revisa la conexión y vuelve a probar.',
  timeout: 'El servidor tarda en responder. Vuelve a probar.',
  tooMany: 'Demasiados intentos. Espera un minuto y vuelve a probar.',
  server: 'El servidor ha fallado. Vuelve a probar en un momento.',
  session: 'Tu sesión ha caducado. Vuelve a entrar.',
} as const;

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** fetch con tiempo máximo. Sin respuesta (red o tiempo) lanza un Error con el texto para la cajera. */
export async function send(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new Error(name === 'TimeoutError' || name === 'AbortError' ? MESSAGES.timeout : MESSAGES.network);
  }
}

/** Errores que se explican igual en cualquier petición; null si es otro. */
export function commonError(status: number): string | null {
  if (status === 429) return MESSAGES.tooMany;
  if (status >= 500) return MESSAGES.server;
  return null;
}

/** El detail / message / title de un ProblemDetails del API; si no hay, `fallback`. */
export async function readError(res: Response, fallback: string): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return fallback;
  }
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; title?: unknown };
    const msg = body.detail ?? body.message ?? body.title;
    if (typeof msg === 'string' && msg.trim()) return msg;
    if (Array.isArray(msg)) return msg.join(' · ');
  } catch {
    // No es JSON (p. ej. la página de error de un proxy): mejor el texto genérico.
  }
  return fallback;
}
