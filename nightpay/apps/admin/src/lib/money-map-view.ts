// El mapa del dinero en el panel (maqueta 8 · A, barras apiladas), lógica
// pura: de lo que devuelve GET /v1/admin/money-map a lo que se pinta. El color
// es solo de las secciones (el de la marca, o el que puso el dueño); canales y
// destinos van en grises (variables --np-mm-* de panel-money.css). Sin IVA.

import {
  DEFAULT_SECTIONS,
  MONEY_MAP_TIPS,
  isSectionCode,
  sectionMeta,
  venueSharePercent,
  type MoneyMap,
  type VenueSection,
} from '@nightpay/contracts';
import { SECTIONS, sectionColor } from '@nightpay/ui';

/** Euros sin céntimos si son redondos y con el punto de los miles siempre: «5.300 €», «12,50 €». */
// useGrouping «always» (ES2023): en español, 1.800 y no 1800. Los tipos de TS aún no lo traen.
const ALWAYS = { useGrouping: 'always' } as unknown as Intl.NumberFormatOptions;
const EUR_WHOLE = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, ...ALWAYS });
const EUR_CENTS = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, ...ALWAYS });

export function eurShort(cents: number): string {
  return cents % 100 === 0 ? EUR_WHOLE.format(cents / 100) : EUR_CENTS.format(cents / 100);
}

/** Nombre y color de una sección: el nombre del local; el color de la marca, salvo que el dueño lo cambiara. */
export function sectionPaint(sections: readonly VenueSection[], code: string): { label: string; color: string } {
  if (code === MONEY_MAP_TIPS) return { label: SECTIONS.propinas.label, color: SECTIONS.propinas.color };
  const meta = sectionMeta(sections, code);
  const own = sections.find((s) => s.code === code);
  const custom = own && isSectionCode(code) && own.color.toLowerCase() !== DEFAULT_SECTIONS[code].color.toLowerCase();
  return { label: meta.label, color: custom ? own.color : sectionColor(code) };
}

/** Un trozo de una barra apilada (o de la franja de arriba). */
export interface Segment {
  key: string;
  label: string;
  cents: number;
  /** Color: el de la sección, o una variable CSS (los grises de canales y destinos). */
  color: string;
}

export interface SectionRow extends Segment {
  /** Ancho de su barra, en % de la sección que más vende. */
  pct: number;
}

export interface OutRow {
  key: string;
  label: string;
  note: string;
  cents: number;
}

export interface MoneyMapView {
  /** «Ventas de la noche» o «Ventas del periodo». */
  salesLabel: string;
  salesCents: number;
  venueCents: number;
  venuePct: number;
  stripe: Segment[];
  /** Solo los canales con algo: aquí el efectivo entra como recarga (si un día hay cobros en efectivo, saldrán). */
  inflow: Segment[];
  /** «+ Recargas 3.070 €: efectivo 1.070 € · tarjeta 2.000 € · no es venta» (null si no hubo). */
  topUps: { cents: number; detail: string } | null;
  sections: SectionRow[];
  where: { totalCents: number; places: Segment[]; owners: Segment[]; note: string | null };
  outflow: OutRow[];
}

/** Los trozos con importe (los que no, no se pintan; los negativos tampoco caben en una barra). */
export function barSegments(segments: readonly Segment[]): Segment[] {
  return segments.filter((s) => s.cents > 0);
}

/** La leyenda en el mismo orden que la barra, con un ancho mínimo para que se lea. */
export function legendFlex(cents: number, total: number): number {
  if (total <= 0) return 1;
  return Math.max(cents, total * 0.18);
}

const RAIL_NOTE: Readonly<Record<string, string>> = {
  MANUAL_CASH: 'efectivo',
  SEPA_IBAN: 'transferencia',
  WIRE_INTERNATIONAL: 'transferencia',
};

/** «efectivo», «transferencia», «cripto»… para la vía de un pago al personal. */
export function railNote(rail: string | null): string {
  if (!rail) return 'sin decir cómo';
  if (RAIL_NOTE[rail]) return RAIL_NOTE[rail]!;
  if (/^(USDT|USDC|BINANCE|OKX|BYBIT)/.test(rail)) return 'cripto';
  return 'cuenta';
}

/** Las secciones que se enseñan: las encendidas, más cualquiera con importe (y «Otros», las propinas). */
function sectionRows(m: MoneyMap, sections: readonly VenueSection[]): SectionRow[] {
  const enabled = new Set(sections.filter((s) => s.enabled).map((s) => s.code as string));
  const shown = m.sections.filter((s) => s.amountCents !== 0 || enabled.has(s.code) || s.code === MONEY_MAP_TIPS);
  const max = Math.max(0, ...shown.map((s) => s.amountCents));
  return shown.map((s) => ({
    key: s.code,
    ...sectionPaint(sections, s.code),
    cents: s.amountCents,
    pct: max > 0 ? Math.max(0, Math.round((s.amountCents * 100) / max)) : 0,
  }));
}

function outflowRows(m: MoneyMap): OutRow[] {
  const o = m.outflow;
  const who = (w: 'chicas' | 'camareros') => (w === 'chicas' ? 'Pago a chicas' : 'Pago a camareros');
  const rows: OutRow[] = o.payouts.map((p) => ({
    key: `payout-${p.who}-${p.rail ?? 'none'}`,
    label: who(p.who),
    note: railNote(p.rail),
    cents: p.cents,
  }));
  if (o.pendingStaff.chicasCents > 0) rows.push({ key: 'pending-chicas', label: 'Pago a chicas', note: 'al cerrar', cents: o.pendingStaff.chicasCents });
  if (o.pendingStaff.camarerosCents > 0) {
    rows.push({ key: 'pending-camareros', label: 'Pago a camareros', note: 'al cerrar', cents: o.pendingStaff.camarerosCents });
  }
  if (o.refunds.cardCents > 0) rows.push({ key: 'refund-card', label: 'Devoluciones', note: 'tarjeta', cents: o.refunds.cardCents });
  if (o.refunds.cashCents > 0) rows.push({ key: 'refund-cash', label: 'Devoluciones', note: 'efectivo', cents: o.refunds.cashCents });
  const bank = m.split.commissions.bankCents;
  rows.push({
    key: 'commissions',
    label: 'Comisiones',
    note: bank === null ? 'OxioPay (el banco, en su extracto)' : 'banco y OxioPay',
    cents: o.commissionsCents,
  });
  return rows;
}

/** Lo que se ve debajo de «Dónde está» si el saldo vivo o lo debido de ahora no son los de esta noche. */
function whereNote(m: MoneyMap): string | null {
  const parts: string[] = [];
  const live = m.where.liveSaldoCents;
  if (live !== null && live !== m.where.owners.saldoCents) parts.push(`saldo vivo de los clientes ahora: ${eurShort(live)}`);
  const owed = m.where.owed;
  if (owed) {
    const total = owed.chicasCents + owed.camarerosCents;
    if (total !== m.where.owners.staffCents) parts.push(`se debe al personal en total: ${eurShort(total)}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function moneyMapView(m: MoneyMap, sections: readonly VenueSection[]): MoneyMapView {
  const rows = sectionRows(m, sections);
  const i = m.inflow;
  const staff = m.where.owners.staffCents;
  const camareros = m.outflow.pendingStaff.camarerosCents;
  return {
    salesLabel: m.scope.kind === 'night' ? 'Ventas de la noche' : 'Ventas del periodo',
    salesCents: m.salesCents,
    venueCents: m.split.venueCents,
    venuePct: venueSharePercent(m),
    stripe: barSegments(rows),
    inflow: (
      [
        { key: 'card', label: 'Tarjeta', cents: i.cardRailCents, color: 'var(--np-mm-tarjeta)' },
        { key: 'cash', label: 'Efectivo', cents: i.cashCents, color: 'var(--np-mm-efectivo)' },
        { key: 'saldo', label: 'Del saldo', cents: i.saldoCents, color: 'var(--np-mm-saldo)' },
      ] satisfies Segment[]
    ).filter((s) => s.cents !== 0),
    topUps:
      i.topUps.totalCents !== 0
        ? {
            cents: i.topUps.totalCents,
            detail: [
              i.topUps.cashCents ? `efectivo ${eurShort(i.topUps.cashCents)}` : null,
              i.topUps.cardCents ? `tarjeta ${eurShort(i.topUps.cardCents)}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : null,
    sections: rows,
    where: {
      totalCents: m.where.totalCents,
      places: [
        { key: 'bbva', label: 'BBVA, mañana', cents: m.where.bbvaCents, color: 'var(--np-mm-tarjeta)' },
        { key: 'cash', label: 'Caja', cents: m.where.cashBoxCents, color: 'var(--np-mm-efectivo)' },
      ],
      owners: [
        { key: 'venue', label: 'Tuyo', cents: m.where.owners.venueCents, color: 'var(--np-mm-tuyo)' },
        {
          key: 'staff',
          label: camareros > 0 && staff > camareros ? 'Del personal' : camareros > 0 ? 'De camareros' : 'De chicas',
          cents: staff,
          color: 'var(--np-mm-personal)',
        },
        { key: 'saldo', label: 'Saldo vivo', cents: m.where.owners.saldoCents, color: 'var(--np-mm-saldo)' },
      ],
      note: whereNote(m),
    },
    outflow: outflowRows(m),
  };
}
