/**
 * El enlace del saldo del cliente (/w/<token>) es su credencial para aceptar
 * cobros: en los logs se queda como /w/***.
 */
export function redactWalletToken(url: string): string {
  return url.replace(/^\/w\/[^/?#]+/, '/w/***');
}
