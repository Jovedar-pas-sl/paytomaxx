// Enlaces que vienen de datos (recibos de pago…): solo http(s). Un
// "javascript:" guardado no se convierte en un enlace que se pueda pulsar.

export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Imagen PNG en línea (el QR de la 2FA). Otra cosa no se pinta como imagen. */
export function isPngDataUrl(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(raw);
}
