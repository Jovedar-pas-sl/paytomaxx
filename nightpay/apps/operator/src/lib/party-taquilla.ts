// OxioParty · la taquilla (maqueta Taquilla.dc.html): la recepción de siempre
// con otra pantalla para cargar la pulsera. El importe (10, 20, 50 € u
// «Otro»), cómo paga (efectivo o tarjeta) y, en efectivo, con qué billete paga
// y el cambio. El botón dice lo que hace. Funciones puras; los endpoints son
// los de la recepción (/v1/reception/*, /v1/payments para la tarjeta).

import { fichaShort } from './ficha-number';
import { formatEur } from './money';
import type { LoadedMethod, MethodButton, NumberSaldo, ReceptionDeskView } from './reception-desk';
import type { PayMethod } from './reception';

/** Los importes rápidos de la taquilla. */
export const PARTY_QUICK_AMOUNTS: readonly number[] = [1_000, 2_000, 5_000];

/** El importe marcado al leer una pulsera (el de la maqueta). */
export const PARTY_DEFAULT_AMOUNT = 2_000;

/** Los billetes de «Te da». */
export const GIVEN_BILLS: readonly number[] = [2_000, 5_000, 10_000];

/** «20 €»: los importes de la taquilla, sin céntimos si no los hay. */
export function shortEur(cents: number): string {
  return formatEur(cents, { compact: true });
}

/** ¿Es uno de los importes rápidos? (si no, lo marca «Otro»). */
export function isQuickAmount(cents: number): boolean {
  return PARTY_QUICK_AMOUNTS.includes(cents);
}

/**
 * El cambio que se le devuelve: lo que da menos lo que paga (la carga más la
 * comisión del servicio, si el local la tiene). null: aún no ha dado nada o
 * no le llega.
 */
export function changeCents(chargeCents: number, givenCents: number | null): number | null {
  if (givenCents === null || givenCents < chargeCents) return null;
  return givenCents - chargeCents;
}

/** Los billetes de «Te da»: los que no llegan, apagados. */
export function givenOptions(chargeCents: number): Array<{ cents: number; enough: boolean }> {
  return GIVEN_BILLS.map((cents) => ({ cents, enough: cents >= chargeCents }));
}

/** El billete marcado: el que había si aún llega; si no, ninguno. */
export function keepGiven(givenCents: number | null, chargeCents: number): number | null {
  return givenCents !== null && givenCents >= chargeCents ? givenCents : null;
}

/** El botón de abajo: «Cargar 20 € en efectivo» o «Cobrar 20 € con tarjeta». */
export function taquillaCta(method: PayMethod, amountCents: number): string {
  return method === 'cash' ? `Cargar ${shortEur(amountCents)} en efectivo` : `Cobrar ${shortEur(amountCents)} con tarjeta`;
}

/**
 * Cómo paga, marcado al abrir: la forma del local que se puede usar (la de
 * por defecto va primera en `methodButtons`); null: ninguna.
 */
export function initialMethod(buttons: readonly MethodButton[]): PayMethod | null {
  return (buttons.find((b) => b.problem === null) ?? buttons[0])?.method ?? null;
}

/** El aviso de la tarjeta (maqueta): qué pasa al cobrar con ella. */
export const CARD_INFO =
  'Saldrá un QR. El cliente paga en su móvil con Apple Pay, Google Pay o tarjeta, y el dinero entra en la cuenta del organizador.';

export interface LoadedRow {
  label: string;
  value: string;
}

/**
 * El detalle de CARGADO (maqueta): la pulsera, el saldo que tiene ahora y,
 * en efectivo, el cambio a devolver (si se marcó con qué billete pagó); con
 * tarjeta, «Pagado con Tarjeta». Lo que no se sabe no sale.
 */
export function loadedRows(o: { pulsera: string | null; balanceCents: number | null; method: LoadedMethod; changeCents: number | null }): LoadedRow[] {
  const rows: LoadedRow[] = [];
  if (o.pulsera) rows.push({ label: 'Pulsera', value: o.pulsera });
  if (o.balanceCents !== null) rows.push({ label: 'Saldo ahora', value: formatEur(o.balanceCents) });
  if (o.method === 'card') rows.push({ label: 'Pagado con', value: 'Tarjeta' });
  else if (o.changeCents !== null) rows.push({ label: 'Cambio a devolver', value: formatEur(o.changeCents) });
  return rows;
}

/** La pulsera leída, arriba de la taquilla (maqueta: «P-0412 · Nueva · Saldo 0,00 €»). */
export interface PulseraCard {
  /** «Pulsera 1013», «Pulsera nueva», «Saldo K7Q-4M2». */
  title: string;
  /** Sin saldo todavía: la etiqueta «Nueva». */
  isNew: boolean;
  /** «Saldo 0,00 €», «Saldo 12,00 € · K7Q-4M2». */
  detail: string;
}

/**
 * Lo leído en la taquilla: la pulsera acercada (nueva o con saldo), la
 * buscada por su número (el código, tapado) o un saldo sin pulsera.
 */
export function pulseraCard(read: { view: ReceptionDeskView | null; number?: NumberSaldo }): PulseraCard {
  const saldo = (cents: number) => `Saldo ${formatEur(cents)}`;
  if (read.number) {
    const n = read.number;
    return { title: `Pulsera ${fichaShort(n.printedNumber) ?? n.printedNumber}`, isNew: false, detail: `${saldo(n.balanceCents)} · ${n.codeHint}` };
  }
  const view = read.view;
  if (!view) return { title: 'Saldo nuevo', isNew: true, detail: 'Sin pulsera: se queda con su código' };
  const short = fichaShort(view.printedNumber ?? null);
  if (view.kind === 'new') return { title: short ? `Pulsera ${short}` : 'Pulsera nueva', isNew: true, detail: saldo(0) };
  if (view.fichaNumber === null) return { title: `Saldo ${view.code}`, isNew: false, detail: `${saldo(view.balanceCents)} · sin pulsera` };
  return { title: short ? `Pulsera ${short}` : 'Pulsera sin número', isNew: false, detail: `${saldo(view.balanceCents)} · ${view.code}` };
}
