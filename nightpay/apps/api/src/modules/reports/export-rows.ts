/**
 * Filas que lee el informe para la gestoría (Fase 1C). Las consultas están en
 * reports.service.ts; aquí, los tipos y las etiquetas en castellano.
 */

/** Un cobro pagado del periodo, con lo devuelto y la parte de la chica. */
export interface CobroRow {
  id: string;
  paidAt: Date;
  status: string;
  amountCents: number;
  tipCents: number;
  revenueCategory: string;
  captureMethod: string | null;
  serviceName: string | null;
  payMethod: string | null;
  payMethodCode: string | null;
  cardBrand: string | null;
  cardType: string | null;
  cardCountry: string | null;
  authCode: string | null;
  providerTxId: string | null;
  walletId: string | null;
  creatorName: string | null;
  creatorEmail: string | null;
  /** Chica a la que va la parte del cobro (normalmente quien lo cobró). */
  earningOperatorName: string | null;
  earningOperatorEmail: string | null;
  /** Devuelto hasta hoy (todas las devoluciones del cobro). */
  refundedCents: number;
  /** Comisión de la chica (null = el cobro no genera parte para una chica). */
  commissionCents: number | null;
  earningTipCents: number | null;
  reversedCents: number | null;
  /**
   * Lo descontado por devoluciones que llegaron con la chica ya pagada: es
   * deuda suya (earning_reversals.afterPayout) y no está en reversedCents.
   */
  reversedAfterPayoutCents: number;
}

/**
 * Un consumo del saldo del cliente (no anulado). El dinero entró con la
 * recarga: aquí cuenta como venta por tipo y, si lo cobró una chica, su parte
 * (sin chica, los campos de la chica van a null: p. ej. la barra).
 */
export interface ConsumoRow {
  id: string;
  at: Date;
  amountCents: number;
  tipCents: number;
  /** Tipo de venta (CHICA_SERVICE, VENUE_BAR…). */
  category: string;
  operatorName: string | null;
  operatorEmail: string | null;
  commissionCents: number | null;
  earningTipCents: number | null;
}

/**
 * Saldo devuelto al cliente que se va. CASH = en efectivo en el local (solo
 * queda aquí); CARD = a la tarjeta en BBVA (además, ya está apuntado como
 * devolución de sus recargas).
 */
export interface PagoSaldoRow {
  id: string;
  at: Date;
  amountCents: number;
  method: string;
  paidByName: string | null;
  paidByEmail: string | null;
}

/** Una devolución hecha en el periodo. */
export interface DevolucionRow {
  id: string;
  refundedAt: Date;
  amountCents: number;
  reason: string | null;
  providerRefundId: string | null;
  registeredManually: boolean;
  byName: string | null;
  byEmail: string | null;
  paymentId: string;
  paidAt: Date;
  providerTxId: string | null;
  chargedCents: number;
  creatorName: string | null;
  creatorEmail: string | null;
  /** Chica a la que se le descontó (la de la parte del cobro). */
  chicaName: string | null;
  chicaEmail: string | null;
  /** Lo que se le descontó a la chica por esta devolución. */
  reversedDeltaCents: number | null;
  /** La devolución llegó cuando ya se le había pagado: queda como deuda. */
  afterPayout: boolean | null;
}

/** Un pago a una chica hecho en el periodo. */
export interface LiquidacionRow {
  id: string;
  paidAt: Date;
  totalCents: number;
  externalRail: string | null;
  externalTxId: string | null;
  reconciliationStatus: string;
  notes: string | null;
  operatorName: string | null;
  operatorEmail: string;
  paidByName: string | null;
  paidByEmail: string | null;
  earningCount: number;
}

export const CATEGORY_LABEL: Record<string, string> = {
  CHICA_SERVICE: 'Servicio de chica',
  VENUE_BAR: 'Barra',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  EXTRA: 'Otro',
};
export const WALLET_LABEL = 'Recarga de wallet';

export const STATUS_LABEL: Record<string, string> = {
  AUTHORIZED: 'Pagado',
  PARTIALLY_REFUNDED: 'Devuelto en parte',
  REFUNDED: 'Devuelto',
};

export const RECONCILIATION_LABEL: Record<string, string> = {
  UNRECONCILED: 'Sin conciliar',
  RECONCILED: 'Conciliado',
};

/** Tipo de cobro para el informe (las recargas de wallet van aparte). */
export function cobroType(r: Pick<CobroRow, 'walletId' | 'revenueCategory'>): string {
  if (r.walletId) return WALLET_LABEL;
  return CATEGORY_LABEL[r.revenueCategory] ?? r.revenueCategory;
}

export function captureLabel(captureMethod: string | null): string {
  if (captureMethod === 'POS_EXTERNAL') return 'Datáfono';
  if (captureMethod === 'WALLET_TOPUP') return WALLET_LABEL;
  return 'Móvil (QR)';
}

/** Botón que pulsó el cliente; en datáfono, el propio datáfono. */
export function methodLabel(r: Pick<CobroRow, 'payMethod' | 'captureMethod'>): string {
  if (r.payMethod === 'wallet') return 'Apple Pay / Google Pay';
  if (r.payMethod === 'card') return 'Tarjeta';
  if (r.captureMethod === 'POS_EXTERNAL') return 'Datáfono';
  return '';
}

export function cardTypeLabel(cardType: string | null): string {
  if (cardType === 'C') return 'Crédito';
  if (cardType === 'D') return 'Débito';
  return cardType ?? '';
}

export function person(name: string | null, email: string | null): string {
  return name?.trim() || email || '';
}

/**
 * Parte de la chica de un cobro: comisión + su propina − lo descontado por
 * devoluciones, también lo que quedó como deuda por llegar con ella ya pagada
 * (igual que el resumen, que resta todo lo descontado).
 */
export function chicaShareCents(
  r: Pick<CobroRow, 'commissionCents' | 'earningTipCents' | 'reversedCents' | 'reversedAfterPayoutCents'>,
): number {
  if (r.commissionCents === null) return 0;
  return r.commissionCents + (r.earningTipCents ?? 0) - (r.reversedCents ?? 0) - r.reversedAfterPayoutCents;
}
