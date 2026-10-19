// Errores del API con código que se explican igual en el móvil y en el datáfono.

/** Código del API → la frase para el personal (el detalle del API, si lo hay, va detrás). */
const CODE_TEXT: Readonly<Record<string, string>> = {
  CASH_LIMIT: 'Tope legal de efectivo (1.000 € en 24 h) alcanzado para este saldo.',
  WALLET_BLOCKED: 'Saldo bloqueado. Avisa al encargado.',
};

/** Con detalle: el de CASH_LIMIT dice cuánto cabe aún («como mucho 49,99 € más»). */
const WITH_DETAIL = new Set(['CASH_LIMIT']);

/** La frase de un error con código conocido; null si el código no es de estos. */
export function codeErrorText(code: string | null | undefined, detail?: string | null): string | null {
  const head = code ? CODE_TEXT[code] : undefined;
  if (!head) return null;
  const extra = detail?.trim();
  return extra && WITH_DETAIL.has(code as string) ? `${head} ${extra}` : head;
}
