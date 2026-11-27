/**
 * El enlace que lleva el QR de un cobro con tarjeta: el mismo para el móvil
 * de quien cobra (la respuesta al crear el cobro) y para la «Pantalla del
 * cliente» de la barra.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Vacío o solo espacios cuenta como «sin configurar» (Dokploy deja la variable definida y vacía). */
function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim().replace(/\/+$/, '') : undefined;
}

function ensureProto(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** El API (páginas del cliente /pay, /s…), la web del cliente si la hay, y la app del personal. */
export function publicBaseUrls(env: Env = process.env): { api: string; client: string; operator: string } {
  const api = ensureProto(nonEmpty(env.NEXT_PUBLIC_API_URL) ?? `http://localhost:${env.PORT ?? 4100}`);
  // Preferimos web-client si está configurado; si no, el API mismo expone
  // /pay/{token} con redirect 302 al checkout del PSP.
  const client = ensureProto(nonEmpty(env.NEXT_PUBLIC_WEB_CLIENT_URL) ?? api);
  // Si NEXT_PUBLIC_OPERATOR_URL no está, se deriva cambiando api. → operator.
  const operator = ensureProto(nonEmpty(env.NEXT_PUBLIC_OPERATOR_URL) ?? api.replace(/^https?:\/\/api\./i, 'https://operator.'));
  return { api, client, operator };
}

/**
 * El QR de un cobro con tarjeta va directo a la página de pago del API
 * (/pay/<token>), sin pasar por la web del cliente (idea 72: antes, un salto
 * más y la propina de la pantalla de la barra se perdía en él). Con datáfono
 * (POS_EXTERNAL) el QR NO lleva a la pasarela (cobraría dos veces): abre la
 * app del personal para confirmar la venta del lector.
 */
export function cardQrUrl(
  p: { id: string; qrToken: string; captureMethod: string | null },
  urls: { api: string; operator: string } = publicBaseUrls(),
): string {
  return p.captureMethod === 'POS_EXTERNAL' ? `${urls.operator}/?pos=${p.id}` : `${urls.api}/pay/${p.qrToken}`;
}
