// fetch con tiempo máximo: sin él, una petición colgada deja el botón girando.

import { ServerUnavailableError } from './errors';

export const REQUEST_TIMEOUT_MS = 15_000;
/** Salir no hace esperar: si el API no contesta en 5 s, la sesión ya se cerró aquí. */
export const LOGOUT_TIMEOUT_MS = 5_000;

export interface RequestMessages {
  readonly network: string;
  readonly timeout: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function abortReason(signal: AbortSignal): Error {
  return isAbortError(signal.reason) ? (signal.reason as Error) : new DOMException('Aborted', 'AbortError');
}

/**
 * fetch con tiempo máximo hasta que llegan las cabeceras (una descarga larga
 * no se corta a medias). Si quien llama cancela (su AbortSignal), se relanza
 * su AbortError tal cual; sin respuesta (red o tiempo) → ServerUnavailableError.
 */
export async function sendRequest(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  messages: RequestMessages,
): Promise<Response> {
  const caller = init.signal ?? undefined;
  // Ya cancelada antes de salir: como fetch, se rechaza sin hacer la petición.
  if (caller?.aborted) throw abortReason(caller);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // También durante la lectura del cuerpo: quien llama puede cancelarla.
  caller?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new ServerUnavailableError(messages.timeout, 0, 'timeout');
    if (caller?.aborted || isAbortError(err)) throw err;
    throw new ServerUnavailableError(messages.network, 0, 'network');
  } finally {
    clearTimeout(timer);
  }
}
