// La cuenta de cobro de una compañera en el panel: siempre tapada; entera,
// solo el dueño con «Ver cuenta para pagar» (2FA) y un rato. Textos puros.
import type { PayoutMethod } from './api';
import { formatDateTime } from './dates';

/** Lo que se ve la cuenta entera tras «Ver cuenta para pagar» antes de taparse sola. */
export const REVEAL_PAYOUT_SECONDS = 60;

/** Segundos que le quedan a la vista (redondeando hacia arriba, nunca negativo). */
export function revealLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Cuenta cambiada hace menos de 48 h: el API no deja «Marcar pagado» a esa
 * cuenta hasta entonces (en efectivo, sí). null si no aplica.
 */
export function payoutHoldText(
  holdUntil: string | null | undefined,
  rail: PayoutMethod | null,
  now: number,
  timeZone: string,
): string | null {
  if (!holdUntil || rail === 'MANUAL_CASH') return null;
  const until = Date.parse(holdUntil);
  if (Number.isNaN(until) || until <= now) return null;
  return `Su cuenta de cobro cambió hace menos de 48 h: a esta cuenta se le puede pagar a partir del ${formatDateTime(holdUntil, timeZone, 'datetime')}. En efectivo, sí.`;
}

/** El titular no se parece al nombre que tiene en el panel: aviso (el nombre legal llegará con su ficha). */
export function holderMismatchText(name: string | null | undefined): string {
  const shown = name?.trim();
  return `El titular no se parece al nombre de la compañera${shown ? ` («${shown}»)` : ''}. Comprueba que la cuenta es suya antes de pagarle.`;
}

/** Sin la 2FA activada no se cambia ni se ve entera una cuenta de cobro: qué hacer (lo mismo que dice el API). */
export function twoFactorNeededText(what: 'change' | 'reveal'): string {
  const action = what === 'change' ? 'cambiar una cuenta de cobro' : 'ver la cuenta de cobro entera';
  return `Para ${action} hace falta la verificación en dos pasos (2FA). Actívala en Ajustes → Seguridad y vuelve aquí.`;
}
