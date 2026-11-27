import { sectionMeta, sectionsOf } from '@nightpay/contracts';
import { chargeSections, type LineAmount } from './charge-sections';

/**
 * Filas que lee el informe para la gestoría (Fase 1C). Las consultas están en
 * reports.service.ts; aquí, los tipos y las etiquetas en castellano.
 */

/**
 * La parte de una persona del personal en un cobro (una ganancia,
 * operator_earnings): la chica que lo cobró, la invitada a una «Copa con
 * invitación» o, si el local se la da, el camarero que la cobró.
 */
export interface StaffPart {
  name: string | null;
  email: string | null;
  /** OPERATOR: una chica. El resto (camarero), su parte de una copa con invitación. */
  role: string;
  commissionCents: number;
  tipCents: number;
  reversedCents: number;
  /** Lo descontado por devoluciones llegadas con la persona ya pagada (deuda): no está en reversedCents. */
  reversedAfterPayoutCents: number;
  /** Lo vendido que le da la parte: en una copa con invitación, sus copas (no la cuenta entera). */
  baseCents: number;
  /** De una copa con invitación. */
  invitation: boolean;
}

/** Lo descontado a una persona por una devolución (earning_reversals). */
export interface RefundStaffPart {
  name: string | null;
  email: string | null;
  role: string;
  reversedDeltaCents: number;
  afterPayout: boolean;
}

/** Un cobro pagado del periodo, con lo devuelto y la parte de la chica. */
export interface CobroRow {
  id: string;
  paidAt: Date;
  status: string;
  amountCents: number;
  tipCents: number;
  /**
   * «Comisión del servicio» que pagó el cliente encima (service-fee.ts): se
   * debe a OxioPay, no es del local. Sin el campo (filas de antes): 0.
   */
  serviceFeeCents?: number;
  /** …de ella, lo devuelto con las devoluciones del cobro hasta hoy (refunds.serviceFeeCents). */
  refundedServiceFeeCents?: number;
  revenueCategory: string;
  /** Sus líneas (payment_lines), cada una en su sección. Null/vacío: un cobro de antes (su revenueCategory). */
  lines?: LineAmount[] | null;
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
  /**
   * Carga de un saldo nuevo que hizo el cliente con el enlace del local
   * («Cargar saldo antes de llegar»): «Desde casa» en la columna «Origen». Lo
   * decide reports.service (withOrigin) y la Idempotency-Key no sigue en la
   * fila. Solo va con true: sin el campo, no es una de ellas.
   */
  fromHome?: boolean;
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
  /**
   * Todas las partes del personal del cobro (una por persona: chicas y, si el
   * local se la da, el camarero de una copa con invitación). Sin el campo
   * (filas de antes), la de la chica de las columnas de arriba.
   */
  staff?: StaffPart[] | null;
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
  /** Tipo de venta (CHICA_SERVICE, VENUE_BAR…): su sección principal. */
  category: string;
  /** Las líneas del cobro del saldo, cada una en su sección. Null/vacío: un consumo de antes (su category). */
  lines?: LineAmount[] | null;
  operatorName: string | null;
  operatorEmail: string | null;
  commissionCents: number | null;
  earningTipCents: number | null;
  /** Todas las partes del personal del consumo (como en CobroRow.staff); sin el campo, la de arriba. */
  staff?: StaffPart[] | null;
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
  /** Referencia de la devolución en el banco (a la tarjeta). */
  bankReference?: string | null;
  paidByName: string | null;
  paidByEmail: string | null;
}

/**
 * Recarga del saldo en efectivo cobrada en este local (recepción). No pasa
 * por el banco: es dinero cobrado al cargarlo (como la recarga con tarjeta) y
 * entra en la caja; quien la cobró es la persona o el datáfono de recepción.
 */
export interface RecargaEfectivoRow {
  id: string;
  at: Date;
  /** El saldo cargado. Negativo en una anulación (voidOfId: la recarga que anula). */
  amountCents: number;
  /**
   * «Comisión del servicio» cobrada encima del saldo (entra en la caja y se
   * debe a OxioPay). Negativa en una anulación. Sin el campo: 0.
   */
  serviceFeeCents?: number;
  voidOfId?: string | null;
  /** Por qué se anuló. */
  reason?: string | null;
  /** La recarga abrió un saldo nuevo. */
  createdWallet?: boolean;
  takenByName: string | null;
  takenByEmail: string | null;
  terminalLabel: string | null;
  /**
   * La conexión de otra plataforma (API de socios) cuyo cajero cobró este
   * efectivo, y el nombre del socio. null (o sin el campo): de recepción.
   * Ese efectivo es del local (cuenta en el Z, el IVA y el periodo), pero no
   * está en el cajón de recepción: ver night-rules.cashFromRows().
   */
  partnerConnectionId?: string | null;
  partnerName?: string | null;
}

/**
 * Un apunte del libro de las cargas de los socios (partner_wallet_operations)
 * en el periodo: cada carga a su hora y cada anulación a la suya. La anulación
 * lleva el cajero, la referencia y la descripción de su carga.
 */
export interface RecargaSocioRow {
  id: string;
  /** La carga (la misma, en una carga; la que anula, en una anulación). */
  loadId: string;
  kind: 'LOAD' | 'LOAD_VOID';
  at: Date;
  /** Siempre positivo en el libro: el CSV pone la anulación en negativo. */
  amountCents: number;
  funding: string | null;
  partnerName: string;
  device: string | null;
  reference: string | null;
  description: string | null;
  reason: string | null;
  /** Quién la anuló en el panel; sin nadie, la plataforma (por la API). */
  voidedByName: string | null;
  voidedByEmail: string | null;
}

/** Una devolución hecha en el periodo. */
export interface DevolucionRow {
  id: string;
  refundedAt: Date;
  amountCents: number;
  /** Parte de la devolución que era «Comisión del servicio» (deja de ser de OxioPay). Sin el campo: 0. */
  serviceFeeCents?: number;
  reason: string | null;
  providerRefundId: string | null;
  registeredManually: boolean;
  byName: string | null;
  byEmail: string | null;
  paymentId: string;
  paidAt: Date;
  providerTxId: string | null;
  /** Lo cobrado: importe + comisión del servicio + propina. */
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
  /** Lo descontado a cada persona por esta devolución (chicas y camarero); sin el campo, lo de la chica de arriba. */
  staff?: RefundStaffPart[] | null;
}

/**
 * Ajustes de noches ya cerradas: lo apuntado después de generar su Z con
 * fecha de entonces (su Z está congelado, así que van al Z siguiente).
 */
export interface AdjustmentRows {
  /** Cobros que quedaron pagados tarde (aviso del banco tardío, resueltos a mano…). */
  cobros: CobroRow[];
  /** Devoluciones apuntadas con la fecha del banco de un día ya cerrado. */
  devoluciones: DevolucionRow[];
  /** Consumos del saldo de noches anteriores anulados después. */
  consumosAnulados: ConsumoRow[];
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
  /** A quién se pagó: OPERATOR (una chica) o WAITER (su parte de las copas con invitación). Sin el campo, una chica. */
  role?: string | null;
  paidByName: string | null;
  paidByEmail: string | null;
  earningCount: number;
}

export const CATEGORY_LABEL: Record<string, string> = {
  CHICA_SERVICE: 'Servicio de chica',
  VENUE_BAR: 'Barra',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  VENUE_ENTRY: 'Entrada',
  EXTRA: 'Otro',
};
/**
 * Recarga de saldo cobrada con tarjeta (QR, Apple/Google Pay o el datáfono de
 * recepción): hace pareja con «Recarga en efectivo». Al usuario, nunca «wallet».
 */
export const WALLET_LABEL = 'Recarga con tarjeta';

export const STATUS_LABEL: Record<string, string> = {
  AUTHORIZED: 'Pagado',
  PARTIALLY_REFUNDED: 'Devuelto en parte',
  REFUNDED: 'Devuelto',
};

export const RECONCILIATION_LABEL: Record<string, string> = {
  UNRECONCILED: 'Sin conciliar',
  RECONCILED: 'Conciliado',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

/** El nombre de una sección (por su código) en un informe. */
export type SectionLabeler = (code: string) => string;

/**
 * Los nombres de sección del local: los de Ajustes → Secciones (venues.sections)
 * y, los que no cambió, los de fábrica de la app; los cobros de antes sin
 * sección, «Otros». Los mismos que el panel y la app (sectionMeta).
 */
export function venueSectionLabeler(rawSections: unknown): SectionLabeler {
  const sections = sectionsOf(rawSections);
  return (code) => sectionMeta(sections, code).label;
}

/** Lo cobrado de cada sección (por líneas; los de antes, en su revenueCategory). Las recargas: ninguna. */
export function cobroSections(r: Pick<CobroRow, 'walletId' | 'revenueCategory' | 'amountCents' | 'lines'>): Map<string, number> {
  if (r.walletId) return new Map();
  return chargeSections({ amountCents: r.amountCents, category: r.revenueCategory, lines: r.lines });
}

/** Lo consumido del saldo en cada sección (por líneas; los de antes, en su category). */
export function consumoSections(r: Pick<ConsumoRow, 'category' | 'amountCents' | 'lines'>): Map<string, number> {
  return chargeSections({ amountCents: r.amountCents, category: r.category, lines: r.lines });
}

/**
 * Tipo de cobro para el informe (las recargas con tarjeta van aparte): el de
 * su sección o, con varias secciones, todas («Copas + Cocina»), con el nombre
 * que les dé `labelOf` (el del local: venueSectionLabeler).
 */
export function cobroType(
  r: Pick<CobroRow, 'walletId' | 'revenueCategory'> & Partial<Pick<CobroRow, 'amountCents' | 'lines'>>,
  labelOf: SectionLabeler = categoryLabel,
): string {
  if (r.walletId) return WALLET_LABEL;
  const codes = [...cobroSections({ amountCents: r.amountCents ?? 0, lines: r.lines, walletId: null, revenueCategory: r.revenueCategory }).keys()];
  return codes.length === 0 ? labelOf(r.revenueCategory) : codes.map(labelOf).join(' + ');
}

export function captureLabel(captureMethod: string | null): string {
  if (captureMethod === 'POS_EXTERNAL') return 'Datáfono';
  if (captureMethod === 'WALLET_TOPUP') return WALLET_LABEL;
  return 'Móvil (QR)';
}

/** Botón que pulsó el cliente; en datáfono, el propio datáfono. */
export function methodLabel(r: Pick<CobroRow, 'payMethod' | 'captureMethod'>): string {
  if (r.payMethod === 'wallet') return 'Apple Pay / Google Pay';
  if (r.payMethod === 'bitcoin') return 'Bitcoin';
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

/** ¿Es de una chica? (el resto: un camarero con parte de una copa con invitación). */
export function isChicaPart(p: Pick<StaffPart, 'role'>): boolean {
  return p.role === 'OPERATOR';
}

/** Las partes del personal de un cobro; sin `staff` (filas de antes), la de la chica de sus columnas. */
export function cobroStaff(r: CobroRow): StaffPart[] {
  if (r.staff) return r.staff;
  if (r.commissionCents === null) return [];
  return [
    {
      name: r.earningOperatorName,
      email: r.earningOperatorEmail,
      role: 'OPERATOR',
      commissionCents: r.commissionCents,
      tipCents: r.earningTipCents ?? 0,
      reversedCents: r.reversedCents ?? 0,
      reversedAfterPayoutCents: r.reversedAfterPayoutCents,
      baseCents: r.amountCents,
      invitation: false,
    },
  ];
}

/** Las partes del personal de un consumo del saldo; sin `staff`, la de la chica de sus columnas. */
export function consumoStaff(r: ConsumoRow): StaffPart[] {
  if (r.staff) return r.staff;
  if (r.commissionCents === null) return [];
  return [
    {
      name: r.operatorName,
      email: r.operatorEmail,
      role: 'OPERATOR',
      commissionCents: r.commissionCents,
      tipCents: r.earningTipCents ?? 0,
      reversedCents: 0,
      reversedAfterPayoutCents: 0,
      baseCents: r.amountCents,
      invitation: false,
    },
  ];
}

/** Lo descontado a cada persona por una devolución; sin `staff`, lo de la chica de sus columnas. */
export function refundStaff(r: DevolucionRow): RefundStaffPart[] {
  if (r.staff) return r.staff;
  if (r.reversedDeltaCents === null) return [];
  return [{ name: r.chicaName, email: r.chicaEmail, role: 'OPERATOR', reversedDeltaCents: r.reversedDeltaCents, afterPayout: Boolean(r.afterPayout) }];
}

/** «Comisión del servicio» de un cobro que se queda OxioPay: la cobrada − la devuelta. */
export function cobroServiceFeeNetCents(r: Pick<CobroRow, 'serviceFeeCents' | 'refundedServiceFeeCents'>): number {
  return (r.serviceFeeCents ?? 0) - (r.refundedServiceFeeCents ?? 0);
}

/** Lo que pagó el cliente por un cobro: importe + comisión del servicio + propina. */
export function cobroChargedCents(r: Pick<CobroRow, 'amountCents' | 'serviceFeeCents' | 'tipCents'>): number {
  return r.amountCents + (r.serviceFeeCents ?? 0) + r.tipCents;
}

/** Lo de una persona en un cobro: comisión + propina − lo descontado (también la deuda). */
export function partNetCents(p: StaffPart): number {
  return p.commissionCents + p.tipCents - p.reversedCents - p.reversedAfterPayoutCents;
}

/**
 * Lo vendido a su nombre: lo cobrado (con la propina) si es suyo; en una copa
 * con invitación que cobró otra persona, sus copas (no la cuenta entera).
 */
export function partChargedCents(p: StaffPart, sale: { amountCents: number; tipCents: number }): number {
  return p.invitation ? p.baseCents : sale.amountCents + sale.tipCents;
}

/**
 * Parte de las chicas de un cobro: comisión + su propina − lo descontado por
 * devoluciones, también lo que quedó como deuda por llegar con ella ya pagada
 * (igual que el resumen, que resta todo lo descontado). Si hay dos (la que lo
 * cobró y la invitada a una copa), las dos.
 */
export function chicaShareCents(r: CobroRow): number {
  return cobroStaff(r).filter(isChicaPart).reduce((a, p) => a + partNetCents(p), 0);
}

/** Parte del camarero de un cobro (una copa con invitación, si el local se la da). */
export function camareroShareCents(r: CobroRow): number {
  return cobroStaff(r).filter((p) => !isChicaPart(p)).reduce((a, p) => a + partNetCents(p), 0);
}
