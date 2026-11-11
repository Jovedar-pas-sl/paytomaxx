/**
 * La dirección del panel (para el enlace de «Compartir» de un cobro):
 * ADMIN_BASE_URL si está; si no, la del API con «admin.» en vez de «api.»
 * (api.paytomaxx.com → admin.paytomaxx.com); en local, localhost:4103. Sin
 * ninguna, null (el detalle sale sin enlace).
 */
export function adminPanelBaseUrl(env: { adminBaseUrl?: string; apiUrl?: string; production: boolean }): string | null {
  const explicit = env.adminBaseUrl?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  try {
    const api = env.apiUrl?.trim() ? new URL(env.apiUrl.trim()) : null;
    if (api && api.hostname.startsWith('api.')) return `${api.protocol}//admin.${api.hostname.slice(4)}${api.port ? `:${api.port}` : ''}`;
  } catch {
    // Una dirección mal escrita: como si no estuviera.
  }
  return env.production ? null : 'http://localhost:4103';
}
