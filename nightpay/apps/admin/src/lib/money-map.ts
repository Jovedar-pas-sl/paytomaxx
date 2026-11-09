// El mapa del dinero en el panel (lógica pura): la sección que se enseña de
// cada cobro (su color o «Varias»), el texto de sus líneas y los filtros.

import {
  DEFAULT_SECTIONS,
  SECTION_CODES,
  TOP_UP_SECTION_META,
  sectionMeta,
  type CobroRow,
  type SectionCode,
  type VenueSection,
} from '@nightpay/contracts';
import type { PaymentRow } from './endpoints/payments';

/** Las de fábrica, mientras llegan las del local. */
export const FALLBACK_SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));

export interface SectionChipView {
  label: string;
  color: string | null;
  /** Lo que sale al pasar por encima («Servicios 120 € · Habitaciones 30 €»). */
  title: string | null;
}

/** La sección de un cobro: la suya, «Varias» si hay más de una, «Recarga» o «—». */
export function sectionChip(
  row: Pick<CobroRow, 'sections' | 'isTopUp'>,
  sections: readonly VenueSection[],
  eur: (cents: number) => string,
): SectionChipView {
  if (row.isTopUp) return { label: TOP_UP_SECTION_META.label, color: TOP_UP_SECTION_META.color, title: null };
  if (row.sections.length === 0) return { label: '—', color: null, title: null };
  const parts = row.sections.map((s) => ({ ...sectionMeta(sections, s.category), amountCents: s.amountCents }));
  const title = parts.map((p) => `${p.label} ${eur(p.amountCents)}`).join(' · ');
  if (parts.length === 1) return { label: parts[0]!.label, color: parts[0]!.color, title };
  return { label: 'Varias', color: null, title };
}

const CHIP_INK = '#14110f';
const CHIP_WHITE = '#ffffff';

/** Luminancia relativa WCAG de un canal sRGB (0-255). */
function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Texto legible sobre el color de la sección: tinta o blanco, el que más
 * contraste dé (WCAG). La media ponderada de antes ponía blanco sobre el
 * magenta de Servicios (3,6:1, no llega a AA); con tinta, 5,2:1, como en la
 * app del personal. Todos los de fábrica son claros: van con tinta.
 */
export function chipTextColor(hex: string | null): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return 'var(--np-text)';
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  // Tinta #14110f ≈ 0,0058 de luminancia; blanco, 1.
  const withInk = (l + 0.05) / (0.0058 + 0.05);
  const withWhite = 1.05 / (l + 0.05);
  return withInk >= withWhite ? CHIP_INK : CHIP_WHITE;
}

/** Las secciones que se pueden elegir en un filtro o en la carta (las encendidas). */
export function enabledSections(sections: readonly VenueSection[]): VenueSection[] {
  return sections.filter((s) => s.enabled);
}

export function sectionLabelOf(sections: readonly VenueSection[], code: SectionCode | string): string {
  return sectionMeta(sections, code).label;
}

/** Un cobro pagado con saldo que se puede anular: lo que hace falta para hacerlo (solo dueño y encargado). */
export function reversibleSaldoCharge(row: CobroRow, role: string): { walletId: string; consumptionId: string } | null {
  if (row.kind !== 'SALDO' || row.status !== 'ACCEPTED') return null;
  if (role !== 'OWNER' && role !== 'MANAGER') return null;
  if (!row.wallet || !row.consumptionId) return null;
  return { walletId: row.wallet.id, consumptionId: row.consumptionId };
}

/** Lo que pasa al anularlo, antes de confirmar. */
export function reverseChargeText(row: CobroRow, eur: (cents: number) => string): string {
  const back = eur(row.amountCents + row.tipCents);
  return `Vuelven ${back} al saldo ${row.wallet?.codeHint ?? 'del cliente'}. Si alguien ganó comisión con este cobro, se le descuenta. Queda apuntado en el Z. No se puede deshacer.`;
}

/** Un cobro con tarjeta de la lista, como lo esperan las devoluciones y «Resolver». */
export function paymentRowOf(row: CobroRow): PaymentRow | null {
  const p = row.payment;
  if (row.kind !== 'PAYMENT' || !p) return null;
  return {
    id: row.id,
    amountCents: row.amountCents,
    availableAmountCents: p.availableAmountCents,
    currency: row.currency,
    status: row.status,
    provider: p.provider,
    providerTxId: p.providerTxId,
    createdAt: row.createdAt,
    updatedAt: p.updatedAt,
    authCode: p.authCode,
    cardLast4: p.cardLast4,
    cardBrand: p.cardBrand,
    payMethodCode: p.payMethodCode,
    authorizedAt: p.authorizedAt,
    attempts: p.attempts,
    terminal: p.terminal,
    // Para el aviso de qué parte de lo devuelto es comisión del servicio: en una
    // recarga no se devuelve (lo que cuenta es que tenga saldo, no cuál).
    serviceFeeCents: row.serviceFeeCents ?? 0,
    tipCents: row.tipCents,
    walletId: row.isTopUp ? (row.wallet?.id ?? row.id) : null,
  };
}

/**
 * Cobro único cobrado dos veces (lo pagó el saldo y después el banco aprobó
 * también la tarjeta): lo que dice su fila. Null si no pasó.
 */
export function paidTwiceNote(row: Pick<CobroRow, 'paidTwice'>, eur: (cents: number) => string): string | null {
  const p = row.paidTwice;
  if (!p) return null;
  return p.refunded
    ? `Cobrado dos veces: la tarjeta se devolvió sola (${eur(p.amountCents)})`
    : `Cobrado dos veces: devuelve ${eur(p.amountCents)} a la tarjeta (Incidencias)`;
}
