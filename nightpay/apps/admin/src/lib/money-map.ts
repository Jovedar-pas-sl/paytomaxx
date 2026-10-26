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

/** Texto de color legible sobre el color de la sección (todos los de fábrica son claros). */
export function chipTextColor(hex: string | null): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return 'var(--np-text)';
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Luminancia relativa aproximada (sRGB): con fondo claro, texto oscuro.
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#14110f' : '#ffffff';
}

/** Las secciones que se pueden elegir en un filtro o en la carta (las encendidas). */
export function enabledSections(sections: readonly VenueSection[]): VenueSection[] {
  return sections.filter((s) => s.enabled);
}

export function sectionLabelOf(sections: readonly VenueSection[], code: SectionCode | string): string {
  return sectionMeta(sections, code).label;
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
