import type { PaymentStatus } from '../components/StatusPill';

/** El momento del resultado, a pantalla completa. */
export type OutcomeKind = 'paid' | 'failed' | 'expired';

/** PAGADO / NO PAGADO / CADUCADO; null si aún no hay resultado (o es otro, como cancelado). */
export function outcomeKindOf(status: PaymentStatus): OutcomeKind | null {
  if (status === 'AUTHORIZED') return 'paid';
  if (status === 'FAILED') return 'failed';
  if (status === 'EXPIRED') return 'expired';
  return null;
}

/** La palabra del resultado. Grafito: sin mayúsculas (salvo los códigos). */
export const OUTCOME_TITLE: Record<OutcomeKind, string> = {
  paid: 'Pagado',
  failed: 'No pagado',
  expired: 'Caducado',
};

/**
 * Hora de Madrid (la del local), no la del aparato: un Android o un datáfono
 * en UTC la daría 1-2 h mal.
 */
const MADRID_CLOCK = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Hora de la pantalla «PAGADO» para la franja que se mueve ("23:41:07"), en hora de Madrid. */
export function clockTime(ms: number): string {
  const parts = MADRID_CLOCK.formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}:${part('second')}`;
}
