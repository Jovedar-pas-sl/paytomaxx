/**
 * Helpers compartidos entre Wipay/Peanpe adapters.
 * Extraidos para DRY (vs duplicar pickHeader en cada adapter).
 */

export function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Parser mínimo de form-urlencoded → Record<string,string>.
 */
export function parseFormUrlEncoded(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(
        pair.slice(eq + 1).replace(/\+/g, ' '),
      );
    }
  }
  return out;
}

/**
 * Body persistido en webhook_deliveries → objeto para mapWebhookToFsmEvent.
 * Paytef/Peanpe se guardan como JSON; Redsys/Wipay como form-urlencoded tal
 * cual los manda el banco.
 */
export function parseWebhookBody(rawBody: Buffer): Record<string, unknown> {
  const text = rawBody.toString('utf8').trim();
  if (text === '') return {};
  if (text.startsWith('{')) return JSON.parse(text) as Record<string, unknown>;
  return parseFormUrlEncoded(text);
}
