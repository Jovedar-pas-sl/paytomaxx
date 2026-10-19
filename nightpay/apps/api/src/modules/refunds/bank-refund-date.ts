import { madridDay } from '../../common/time/madrid';
import { madridQuarter } from '../reports/reporting-window';

/** Por qué una devolución del banco no se apunta con el día que dijo el dueño. */
export type BankRefundDateAdjustment = 'before_payment' | 'closed_period';

export interface BankRefundDate {
  /** Con lo que cuenta en los informes (refunds.bankRefundedAt → refundAt). */
  at: Date;
  adjusted: BankRefundDateAdjustment | null;
}

const ADJUSTMENT_TEXT: Record<BankRefundDateAdjustment, string> = {
  before_payment: 'el día es anterior al cobro',
  closed_period: 'su trimestre ya está cerrado',
};

/**
 * Fecha con la que cuenta una devolución apuntada del banco. Los informes la
 * cuentan por bankRefundedAt (Z del periodo, gestoría y el 303 trimestral):
 * una fecha atrás sin tope cambiaría un 303 ya presentado. Regla:
 *  - Nunca antes del cobro. Un día anterior al del cobro (Madrid) es un error
 *    de fecha → hoy. El mismo día pero antes de la hora del cobro (el
 *    mediodía UTC que pone el controlador) → la hora del cobro.
 *  - Solo dentro del trimestre de Madrid en curso: el 303 se presenta por
 *    trimestre y no sabemos si ya se presentó el anterior, así que todo lo
 *    de un trimestre acabado cuenta como ajuste de hoy (en el 303 abierto,
 *    como una rectificación del periodo en que se apunta). Las noches ya
 *    cerradas no hace falta mirarlas: su Z está congelado y lo apuntado
 *    después con su fecha ya va como ajuste del Z siguiente.
 */
export function bankRefundDate(requested: Date, paidAt: Date, now: Date): BankRefundDate {
  if (madridDay(requested) < madridDay(paidAt)) return { at: now, adjusted: 'before_payment' };
  if (requested < madridQuarter(undefined, now).from) return { at: now, adjusted: 'closed_period' };
  return { at: requested < paidAt ? paidAt : requested, adjusted: null };
}

/** Lo que se añade al motivo para que la gestoría vea el día real del banco. */
export function adjustedReason(reason: string, requested: Date, adjusted: BankRefundDateAdjustment): string {
  const [y, m, d] = madridDay(requested).split('-');
  return `${reason} · en el banco el ${d}/${m}/${y}; apuntada con fecha de hoy porque ${ADJUSTMENT_TEXT[adjusted]}`;
}
