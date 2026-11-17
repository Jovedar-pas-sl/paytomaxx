// «Cancelar cobro» con el cliente en la página de su banco (decisión del
// dueño): los primeros 2 minutos (CANCEL_AT_BANK_AFTER_MS) no; pasados sin
// respuesta del banco, sí, avisando de que si su banco lo cobra después se
// devuelve. Antes de ir al banco y con la factura de bitcoin abierta, como
// siempre. La recarga cobrada en el datáfono sin comprobar no está en su
// banco y no se cancela nunca. El API lo hace cumplir igual (409
// CANCEL_AT_BANK_TOO_SOON y CANCEL_HELD_ON_READER): esto es lo que ve el
// personal, con UN solo reloj por pantalla.

import { CANCEL_AT_BANK_AFTER_MS, CANCEL_AT_BANK_TOO_SOON_CODE } from '@nightpay/contracts';

export { CANCEL_AT_BANK_TOO_SOON_CODE };

/** En su banco, los primeros 2 minutos: sin botón. */
export const AT_BANK_PAYING_TEXT = 'El cliente está pagando en su banco';
/** Pasados los 2 minutos: el texto y el botón «Cancelar cobro». */
export const AT_BANK_SLOW_TEXT = 'El banco tarda. Si el cliente no ha pagado, puedes cancelar';
/** Al confirmar con el cliente en su banco. */
export const CANCEL_AT_BANK_TEXT = 'Si su banco lo cobra después, te avisaremos para devolverlo';
/** El API dijo que aún no (el reloj de este móvil iba adelantado): se espera un poco. */
export const CANCEL_TOO_SOON_TEXT = 'El cliente sigue pagando en su banco: aún no se puede cancelar. Espera un poco.';
/** La recarga cobrada en el datáfono sin comprobar: sin botón, nunca (la resuelven en el panel). */
export const HELD_ON_READER_TEXT = 'Cobrado en el datáfono, pendiente de comprobar';

/**
 * Qué ofrece «Cancelar cobro»:
 *  - 'free': no está en su banco (sin empezar a pagar, o con bitcoin): el botón, como siempre;
 *  - 'wait': en su banco, los primeros 2 minutos (o sin saber aún desde cuándo): sin botón;
 *  - 'late': en su banco pasados 2 minutos: el texto y el botón;
 *  - 'held': cobrado en el datáfono sin comprobar (la tarjeta ya pagó): el texto y nunca el botón.
 * El botón sale solo con 'free' o 'late'.
 */
export type BankCancel = 'free' | 'wait' | 'late' | 'held';

/**
 * `cancelableAtMs`: desde cuándo se puede (en el reloj de este móvil); null = aún no se sabe.
 * `heldOnReader`: la recarga cobrada en el datáfono sin comprobar (lo dice el API).
 */
export function bankCancel(atBank: boolean, cancelableAtMs: number | null, nowMs: number, heldOnReader = false): BankCancel {
  if (heldOnReader) return 'held';
  if (!atBank) return 'free';
  return cancelableAtMs !== null && nowMs >= cancelableAtMs ? 'late' : 'wait';
}

/** ¿Sale el botón «Cancelar»? Fuera del banco, o en su banco pasados 2 minutos. */
export function offersCancel(bank: BankCancel | null): boolean {
  return bank === 'free' || bank === 'late';
}

/** Desde cuándo se puede cancelar, sabiendo cuándo salió al banco (en el reloj de este móvil). */
export function cancelableAtFrom(sinceMs: number | null): number | null {
  return sinceMs === null || !Number.isFinite(sinceMs) ? null : sinceMs + CANCEL_AT_BANK_AFTER_MS;
}

/** Lo que dice el API de un cobro de la lista «Sin pagar». */
export interface BankTiming {
  id: string;
  atBank: boolean;
  /** Desde cuándo está en su banco (hora del servidor). Un API de antes no lo trae. */
  atBankSince?: string | null;
  /** Lo que faltaba para poder cancelar al responder (ms; 0 = ya). Un API de antes no lo trae. */
  cancelableInMs?: number;
}

/**
 * La hora a la que se podrá cancelar cada cobro de una lista, en el reloj de
 * este móvil: lo que faltaba al llegar la respuesta, contado desde que llegó.
 * Sin parpadeos: mientras el cobro siga en la misma visita al banco (mismo
 * `atBankSince`) se queda la hora de la primera vez (cada sondeo la movería
 * unos milisegundos); lo que ya se podía cancelar queda en 0. Un API de antes
 * (sin `cancelableInMs`): se puede (decide el servidor).
 */
export function withCancelableAt<T extends BankTiming>(
  previous: ReadonlyArray<T & { cancelableAtMs: number | null }> | null,
  fresh: readonly T[],
  receivedAtMs: number,
): Array<T & { cancelableAtMs: number | null }> {
  const before = new Map((previous ?? []).map((p) => [p.id, p]));
  return fresh.map((item) => {
    if (!item.atBank) return { ...item, cancelableAtMs: null };
    const known = before.get(item.id);
    if (known && known.atBank && known.cancelableAtMs !== null && (known.atBankSince ?? null) === (item.atBankSince ?? null)) {
      return { ...item, cancelableAtMs: known.cancelableAtMs };
    }
    const left = item.cancelableInMs;
    if (left === undefined || left <= 0) return { ...item, cancelableAtMs: 0 };
    return { ...item, cancelableAtMs: receivedAtMs + left };
  });
}

/** El aviso cuando el API dice que aún no (409 con su código); null si es otro error. */
export function cancelTooSoonText(code: string | null | undefined): string | null {
  return code === CANCEL_AT_BANK_TOO_SOON_CODE ? CANCEL_TOO_SOON_TEXT : null;
}
