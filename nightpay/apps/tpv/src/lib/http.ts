// Peticiones al API con tiempo máximo y errores en español para la cajera:
// nunca el JSON crudo del API. Lo de fondo es el cliente común
// (@nightpay/api-client), igual que en el panel y en la app de la chica.

import { REQUEST_TIMEOUT_MS, parseProblemDetails, sendRequest } from '@nightpay/api-client';

export const MESSAGES = {
  network: 'No se pudo conectar con el servidor. Revisa la conexión y vuelve a probar.',
  timeout: 'El servidor tarda en responder. Vuelve a probar.',
  tooMany: 'Demasiados intentos. Espera un minuto y vuelve a probar.',
  server: 'El servidor ha fallado. Vuelve a probar en un momento.',
  session: 'Tu sesión ha caducado. Vuelve a entrar.',
} as const;

/**
 * fetch con tiempo máximo (15 s). Sin respuesta (red o tiempo) lanza un
 * ServerUnavailableError (un Error) con el texto para la cajera.
 */
export function send(url: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  return sendRequest((input, i) => fetch(input, i), url, init, timeoutMs, MESSAGES);
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
  // Un texto plano (p. ej. la página de error de un proxy) no se enseña: solo el JSON del API.
  if (!text.trim().startsWith('{')) return fallback;
  return parseProblemDetails(text).message ?? fallback;
}
