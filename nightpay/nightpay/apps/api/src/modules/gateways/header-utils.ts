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
