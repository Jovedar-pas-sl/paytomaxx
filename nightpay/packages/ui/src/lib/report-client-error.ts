/**
 * Avisa al API de que una pantalla se ha roto (POST /v1/client-errors): lo ve
 * el dueño por Telegram, una vez por hora cada fallo distinto. Sin sesión ni
 * datos de nadie: la app, el mensaje, la huella de Next y la ruta (el API quita
 * la consulta y los tokens). Nunca lanza: la pantalla de fallo no puede fallar.
 */
export function reportClientError(input: {
  apiBase: string;
  app: 'operator' | 'admin' | 'tpv' | 'web-client';
  error: Error & { digest?: string };
}): void {
  try {
    const body = JSON.stringify({
      app: input.app,
      message: String(input.error?.message ?? 'sin mensaje').slice(0, 2_000),
      ...(input.error?.digest ? { digest: input.error.digest.slice(0, 64) } : {}),
      path: typeof location === 'undefined' ? undefined : location.pathname.slice(0, 500),
    });
    void fetch(`${input.apiBase.replace(/\/+$/, '')}/v1/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Sin red o sin fetch: no hay a quién avisar, y la pantalla sigue.
  }
}
