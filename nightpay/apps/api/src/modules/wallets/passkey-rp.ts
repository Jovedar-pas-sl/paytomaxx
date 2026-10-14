/**
 * Dónde vale la llave del cliente (passkey: Face ID, huella o el PIN de su
 * teléfono). El navegador la ata a un dominio (rpID) y firma el origen de la
 * página: solo se aceptan los nuestros.
 *
 * El rpID es el dominio común (paytomaxx.com), no api. ni pay.: así la llave
 * que activa en "Pagado" sirve en el QR de la chica aunque cada página esté en
 * un subdominio distinto. PASSKEY_RP_ID lo fija a mano (dominios tipo .com.es,
 * donde el dominio tiene tres trozos). Si la marca cambia de dominio, los
 * clientes la activan otra vez (no pierden el saldo).
 */
export function relyingParty(
  host: string | undefined,
  env: { apiUrl?: string; webClientUrl?: string; rpId?: string; production: boolean },
): { rpID: string; rpIDs: string[]; origins: string[] } {
  const origins = [env.apiUrl, env.webClientUrl]
    .map((u) => originOf(u))
    .filter((o): o is string => o !== null);
  if (!env.production) origins.push('http://localhost:4100', 'http://127.0.0.1:4100');
  const unique = [...new Set(origins)];
  const fixed = env.rpId?.trim().toLowerCase() || null;
  const rpOf = (origin: string): string => fixed ?? siteOf(new URL(origin).hostname);
  const fromHost = host ? unique.find((o) => new URL(o).host === host.toLowerCase()) : undefined;
  const chosen = fromHost ?? unique[0] ?? 'http://localhost:4100';
  return {
    rpID: rpOf(chosen),
    rpIDs: [...new Set(unique.map(rpOf))],
    origins: unique,
  };
}

/** Los de este despliegue (API y, si hay, web de pago aparte). */
export function currentRelyingParty(host: string | undefined): ReturnType<typeof relyingParty> {
  return relyingParty(host, {
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    webClientUrl: process.env.NEXT_PUBLIC_WEB_CLIENT_URL,
    rpId: process.env.PASSKEY_RP_ID,
    production: process.env.NODE_ENV === 'production',
  });
}

/** api.paytomaxx.com → paytomaxx.com (localhost e IPs, tal cual). */
function siteOf(hostname: string): string {
  if (hostname === 'localhost' || hostname.includes(':') || /^[\d.]+$/.test(hostname)) return hostname;
  const labels = hostname.split('.');
  return labels.length > 2 ? labels.slice(-2).join('.') : hostname;
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
