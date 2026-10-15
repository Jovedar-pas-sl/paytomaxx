import type { PaymentStatus } from '../components/StatusPill';

/** El momento del resultado, a pantalla completa. */
export type OutcomeKind = 'paid' | 'failed' | 'expired';

/** PAGADO / RECHAZADO / CADUCADO; null si aún no hay resultado (o es otro, como cancelado). */
export function outcomeKindOf(status: PaymentStatus): OutcomeKind | null {
  if (status === 'AUTHORIZED') return 'paid';
  if (status === 'FAILED') return 'failed';
  if (status === 'EXPIRED') return 'expired';
  return null;
}

export const OUTCOME_TITLE: Record<OutcomeKind, string> = {
  paid: 'PAGADO',
  failed: 'RECHAZADO',
  expired: 'CADUCADO',
};

/** Hora de la pantalla «PAGADO» para la franja que se mueve ("23:41:07"). */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
