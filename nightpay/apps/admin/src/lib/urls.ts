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
