// Textos de la consola del super-admin: roles, estados, pausas y movimientos
// en castellano llano (quien la usa no es técnico).

import type { CustomerMovement, OperatorCommissionDefaults, Role } from '@nightpay/contracts';
import { formatDateTime } from '../dates';
import { formatEur } from '../money';

export const SA_ROLE_LABELS: Readonly<Record<Role, string>> = {
  OWNER: 'Dueño',
  MANAGER: 'Encargado',
  WAITER: 'Camarero',
  OPERATOR: 'Chica',
};

/** Orden de los roles en los desplegables. */
export const SA_ROLES: readonly Role[] = ['OWNER', 'MANAGER', 'WAITER', 'OPERATOR'];

export const CATEGORY_LABELS: Readonly<Record<keyof OperatorCommissionDefaults, string>> = {
  CHICA_SERVICE: 'Servicio de chica',
  VENUE_BAR: 'Bar / bebida',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  EXTRA: 'Otros',
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as Array<keyof OperatorCommissionDefaults>;

export const VAT_REGIME_LABELS: Readonly<Record<string, string>> = {
  GENERAL: 'General',
  RECARGO_EQUIVALENCIA: 'Recargo de equivalencia',
  EXENTO: 'Exento',
};

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const WALLET_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  ACTIVE: { label: 'Activo', tone: 'success' },
  EXPIRED: { label: 'Caducado', tone: 'neutral' },
  REFUNDED: { label: 'Devuelto', tone: 'neutral' },
  DEPLETED: { label: 'Gastado', tone: 'neutral' },
};

export function walletStatus(status: string): { label: string; tone: Tone } {
  return WALLET_STATUS[status] ?? { label: status, tone: 'neutral' };
}

export const MOVEMENT_LABELS: Readonly<Record<CustomerMovement['kind'], string>> = {
  topup: 'Recarga',
  consumption: 'Consumo',
  payout: 'Devolución',
};

/** "+20,00 €" / "−5,00 €" (signo de verdad, no guion). */
export function formatSignedEur(cents: number): string {
  if (cents === 0) return formatEur(0);
  const sign = cents > 0 ? '+' : '−';
  return `${sign}${formatEur(Math.abs(cents))}`;
}

/** «En pausa desde 16/10/2026, 21:30 por «Impago»» (sin motivo, sin el «por»). */
export function pauseLine(pausedAt: string | null, reason: string | null, timeZone?: string): string {
  const since = pausedAt ? ` desde ${formatDateTime(pausedAt, timeZone, 'datetime')}` : '';
  const why = reason?.trim() ? ` por «${reason.trim()}»` : '';
  return `En pausa${since}${why}`;
}

/** Etiqueta de pausa de un local: la suya o la de su negocio; null = cobra. */
export function venuePauseLabel(v: { paused: boolean; pausedBy: 'venue' | 'business' | null }): string | null {
  if (!v.paused) return null;
  return v.pausedBy === 'business' ? 'En pausa (negocio)' : 'En pausa';
}

/** Qué pasa al pausar: lo mismo para un local que para un negocio. */
export const PAUSE_EFFECT = 'No podrá cobrar ni recargar saldo; las devoluciones y el cierre siguen funcionando.';

/** Días de espera para pagar a las chicas, en llano. */
export function holdDaysText(days: number): string {
  if (days <= 0) return 'Se les paga al cerrar la noche';
  return days === 1 ? '1 día' : `${days} días`;
}

/** Último acceso de una persona: fecha u «Nunca». */
export function lastAccessText(iso: string | null, timeZone?: string): string {
  return iso ? formatDateTime(iso, timeZone, 'datetime') : 'Nunca';
}

/** Nombre para enseñar: el nombre o, si no tiene, el email. */
export function personName(p: { displayName: string | null; email: string }): string {
  return p.displayName?.trim() || p.email;
}

/** Enlace completo a partir de la ruta que da el API ("/w/<token>"). */
export function absoluteApiUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
