/**
 * Dónde vale la llave del cliente (passkey: Face ID, huella o el PIN de su
 * teléfono). El navegador la ata al dominio de la página (rpID) y firma su
 * origen: solo se aceptan los nuestros. Si la marca cambia de dominio, los
 * clientes la activan otra vez (no pierden el saldo).
 */
export function relyingParty(
  host: string | undefined,
  env: { apiUrl?: string; webClientUrl?: string; production: boolean },
): { rpID: string; rpIDs: string[]; origins: string[] } {
  const origins = [env.apiUrl, env.webClientUrl]
    .map((u) => originOf(u))
    .filter((o): o is string => o !== null);
  if (!env.production) origins.push('http://localhost:4100', 'http://127.0.0.1:4100');
  const unique = [...new Set(origins)];
  const fromHost = host ? unique.find((o) => new URL(o).host === host.toLowerCase()) : undefined;
  const chosen = fromHost ?? unique[0] ?? 'http://localhost:4100';
  return {
    rpID: new URL(chosen).hostname,
    rpIDs: [...new Set(unique.map((o) => new URL(o).hostname))],
    origins: unique,
  };
}

/** Los de este despliegue (API y, si hay, web de pago aparte). */
export function currentRelyingParty(host: string | undefined): ReturnType<typeof relyingParty> {
  return relyingParty(host, {
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    webClientUrl: process.env.NEXT_PUBLIC_WEB_CLIENT_URL,
    production: process.env.NODE_ENV === 'production',
  });
}

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withProto).origin;
  } catch {
    return null;
  }
}
