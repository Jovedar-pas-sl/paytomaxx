// La pregunta antes de lo peligroso (idea 49): los textos que antes iban en
// window.confirm, partidos para ConfirmDialog. El título es la pregunta (hasta
// el primer «?») y el resto, la consecuencia. Sin React: se prueba solo
// (confirm-text.test.ts).

/** «¿Bloquear la ficha 522? Ya no podrá pagar con ella.» → título y cuerpo. Sin «?», todo es título. */
export function splitQuestion(text: string): { title: string; body?: string } {
  const at = text.indexOf('?');
  if (at < 0) return { title: text.trim() };
  const title = text.slice(0, at + 1).trim();
  const body = text.slice(at + 1).trim();
  return body ? { title, body } : { title };
}

/** Bloquear la ficha desde la ficha del saldo (WalletFichaModal). */
export function walletFichaBlockText(label: string): string {
  return `¿Bloquear la ficha ${label}? Ya no podrá pagar con ella (el saldo sigue: se le puede dar otra).`;
}

/** Bloquear la ficha desde la lista de saldos (WalletsPanel). */
export function walletBlockText(code: string | null): string {
  return `¿Bloquear la ficha de ${code ?? 'este saldo'}? Ya no servirá para pagar (el saldo sigue).`;
}

/** Desvincular la app de un datáfono (TerminalsPanel). */
export const UNPAIR_TEXT = '¿Desvincular la app de este datáfono? No recibirá cobros hasta que lo vuelvas a vincular.';

/** OxioParty: preparar pulseras nuevas (PulserasSection). */
export function preparePulserasText(n: number): string {
  return `¿Preparar ${n} pulseras nuevas? Salen con números seguidos, ya en el stock.`;
}

/** OxioParty: bloquear una pulsera y pasar su saldo a otra (PulserasSection). */
export function replacePulseraText(from: string, to: string): string {
  return `¿Bloquear ${from} y pasar su saldo a ${to}?`;
}

/** …y lo que pasa, que la pregunta sola no dice. */
export const REPLACE_PULSERA_BODY = 'Deja de pagar al momento y su saldo pasa entero a la nueva.';
