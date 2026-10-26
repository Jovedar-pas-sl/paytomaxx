// Un cobro en el lector del datáfono (PaxChargeFlow): qué se enseña cuando el
// lector no da resultado, cuando el resultado no llega a OxioPay o no lo
// admite, al anular una operación y al cuadrar con el datáfono. Funciones
// puras (se prueban sin pantalla). Regla de siempre: con una venta que pudo
// cobrarse, nunca se ofrece cobrar otra vez sin mirar el datáfono.

import { NOT_ACCEPTED_TITLE, isResultForReference, type ShiftSummary, type VoidReport } from './pax-api';
import type { BridgeResponse, PaytefResult } from './pax-bridge';

export const UNKNOWN_TEXT =
  'No sabemos si se cobró: la última operación del datáfono no es la de este cobro. Revísalo en el datáfono antes de volver a cobrar.';
/** El lector dijo «ok» sin dar el resultado: tampoco se sabe (A2-09). */
export const NO_RESULT_TEXT =
  'No sabemos si se cobró: el datáfono no ha dado el resultado de la operación. Revísalo en el datáfono antes de volver a cobrar.';
const MAYBE_CHARGED_TEXT = 'No sabemos si se cobró. Mira el datáfono antes de volver a cobrar.';
/** Venta aprobada que OxioPay rechazó del todo (4xx): el cliente ya pagó (A2-03). */
export const NOT_ACCEPTED_TEXT = `${NOT_ACCEPTED_TITLE}. No cobres otra vez: anula la operación en el datáfono o avisa al encargado.`;
/** Aprobada y sin llegar a OxioPay: la pantalla la reenvía sola de verdad (A2-05). */
export const UNSENT_NOTE = 'Se reenvía solo cada pocos segundos: no lo cobres otra vez.';

export function readerErrorText(error: string): string {
  switch (error) {
    case 'deviceIsBusy':
      return 'El datáfono está ocupado con otra operación.';
    case 'serviceIsDown':
      return 'El servicio de pago del datáfono no responde.';
    case 'cancelled':
      return 'Cobro cancelado.';
    case 'timeout':
      return 'El lector no responde.';
    default:
      return 'El lector dio un error.';
  }
}

export interface ReaderFailure {
  message: string;
  /** Se ofrece «Recuperar el resultado» (y, tras preguntar, «He mirado el datáfono…»). */
  canRecover: boolean;
}

/**
 * El lector no dio una venta. Con «ok» y sin resultado no se sabe si se cobró:
 * a recuperar, como tras un corte. Cancelado: no se cobró.
 */
export function readerFailure(r: BridgeResponse): ReaderFailure {
  if (r.ok) return { message: NO_RESULT_TEXT, canRecover: true };
  return { message: r.message ?? readerErrorText(r.error), canRecover: r.error !== 'cancelled' };
}

export type RecoverOutcome = { kind: 'deliver'; result: PaytefResult } | ({ kind: 'step' } & ReaderFailure);

/**
 * «Recuperar el resultado» (a mano o solo tras un corte): la operación de este
 * cobro se envía; otra, o ninguna, no se da por «no se cobró».
 */
export function recoverOutcome(r: BridgeResponse, reference: string | null, manual: boolean): RecoverOutcome {
  if (r.ok && r.result) {
    return isResultForReference(r.result, reference)
      ? { kind: 'deliver', result: r.result }
      : { kind: 'step', message: UNKNOWN_TEXT, canRecover: true };
  }
  if (r.ok) return { kind: 'step', message: NO_RESULT_TEXT, canRecover: true };
  if (!manual) return { kind: 'step', message: MAYBE_CHARGED_TEXT, canRecover: true };
  return { kind: 'step', ...readerFailure(r) };
}

/**
 * El resultado no llegó a OxioPay (o no lo admitió). Aprobada: o se reenvía
 * (sin respuesta) o «ya ha pagado» (rechazo definitivo); nunca otra venta.
 * Denegada: el cliente no pagó.
 */
export function deliverFailure(s: { approved: boolean; final: boolean }): 'unsent' | 'notAccepted' | 'readerError' {
  if (!s.approved) return 'readerError';
  return s.final ? 'notAccepted' : 'unsent';
}

const RESEND_FIRST_MS = 3_000;
const RESEND_MAX_MS = 30_000;

/** Cuánto espera el reenvío automático tras `tries` intentos fallidos: 3 s, 6 s, 12 s… hasta 30 s. */
export function resendDelayMs(tries: number): number {
  return Math.min(RESEND_MAX_MS, RESEND_FIRST_MS * 2 ** Math.min(Math.max(tries, 0), 8));
}

/** Tras «Anular en el datáfono»: lo que hizo el lector y si OxioPay se enteró. */
export function voidedMessage(approved: boolean, report: VoidReport): string {
  if (!approved) return 'No se pudo anular. Hazlo desde el menú del datáfono y avisa al encargado.';
  if (report === 'sent') return 'Operación anulada en el datáfono: al cliente no se le cobra dos veces.';
  if (report === 'queued') {
    return 'Operación anulada en el datáfono (al cliente no se le cobra dos veces), pero falta avisar a OxioPay: se reenvía sola desde la lista.';
  }
  return 'Operación anulada en el datáfono, pero OxioPay no la tiene en este cobro: avisa al encargado.';
}

/** «Cuadrar con el datáfono»: sin ventas del datáfono no se ha cuadrado nada (A2-08). */
export function shiftSummaryText(summary: ShiftSummary): string {
  if (summary.total === 0) return 'El datáfono no ha dado ninguna venta: no se ha podido cuadrar.';
  if (summary.unmatched.length === 0) {
    return summary.total === 1
      ? 'Todo cuadra: 1 venta del datáfono, en OxioPay.'
      : `Todo cuadra: ${summary.total} ventas del datáfono, todas en OxioPay.`;
  }
  return `${summary.unmatched.length} de ${summary.total} ventas del datáfono no están en OxioPay. Salen en Incidencias del panel.`;
}
