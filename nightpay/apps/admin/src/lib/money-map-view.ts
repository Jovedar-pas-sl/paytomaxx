// El mapa del dinero en el panel (maqueta 8 · A, barras apiladas), lógica
// pura: de lo que devuelve GET /v1/admin/money-map a lo que se pinta. El color
// es solo de las secciones (el de la marca, o el que puso el dueño); canales y
// destinos van en grises (variables --np-mm-* de panel-money.css). Sin IVA.

import {
  MONEY_MAP_TIPS,
  formatMoney,
  isDefaultSectionColor,
  isSectionCode,
  sectionMeta,
  venueSharePercent,
  type MoneyMap,
  type VenueSection,
} from '@nightpay/contracts';
import { SECTIONS, sectionColor } from '@nightpay/ui';

/** Euros sin céntimos si son redondos y con el punto de los miles siempre: «5.300 €», «12,50 €», «−70 €». */
export function eurShort(cents: number): string {
  return formatMoney(cents, { compact: true });
}

/** Nombre y color de una sección: el nombre del local; el color de la marca, salvo que el dueño lo cambiara. */
export function sectionPaint(sections: readonly VenueSection[], code: string): { label: string; color: string } {
  if (code === MONEY_MAP_TIPS) return { label: SECTIONS.propinas.label, color: SECTIONS.propinas.color };
  const meta = sectionMeta(sections, code);
  const own = sections.find((s) => s.code === code);
  const custom = own && isSectionCode(code) && !isDefaultSectionColor(code, own.color);
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
  /** Las propinas del periodo (van al personal): la tercera cifra de arriba en el escritorio. */
  tipsCents: number;
  /** Cuántos cobros (con tarjeta y del saldo): la cuarta. */
  salesCount: number;
  stripe: Segment[];
  /** Solo los canales con algo: aquí el efectivo entra como recarga (si un día hay cobros en efectivo, saldrán). */
  inflow: Segment[];
  /** «+ Recargas 3.070 €: efectivo 1.070 € · tarjeta 2.000 € · no es venta» (null si no hubo). */
  topUps: { cents: number; detail: string } | null;
  /** «+ Comisión del servicio 186 €: cobros 66 € · recargas 120 € · se debe a OxioPay» (null sin ella). */
  serviceFee: { cents: number; detail: string } | null;
  sections: SectionRow[];
  /** Cómo se reparte lo vendido: el local, el personal y las comisiones (cada uno su gris; las comisiones, rayadas). */
  split: Segment[];
  where: { totalCents: number; places: Segment[]; owners: Segment[]; balance: { label: string; cents: number | null }; note: string | null };
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

/** La comisión del servicio que entró (ventas con tarjeta y recargas), aparte: no es venta. */
function serviceFeeLine(m: MoneyMap): MoneyMapView['serviceFee'] {
  const fee = m.serviceFee;
  const cents = m.inflow.serviceFeeCents ?? 0;
  if (!fee || cents === 0) return null;
  const detail = [fee.salesCents ? `cobros ${eurShort(fee.salesCents)}` : null, fee.topUpsCents ? `recargas ${eurShort(fee.topUpsCents)}` : null]
    .filter(Boolean)
    .join(' · ');
  return { cents, detail };
}

function outflowRows(m: MoneyMap): OutRow[] {
  const o = m.outflow;
  const pendingNote = moneyMapIsCurrent(m) ? 'al cerrar' : 'pendiente al corte';
  const who = (w: 'chicas' | 'camareros') => (w === 'chicas' ? 'Pago a compañeras' : 'Pago a camareros');
  const rows: OutRow[] = o.payouts.map((p) => ({
    key: `payout-${p.who}-${p.rail ?? 'none'}`,
    label: who(p.who),
    note: railNote(p.rail),
    cents: p.cents,
  }));
  if (o.pendingStaff.chicasCents > 0) rows.push({ key: 'pending-chicas', label: 'Pago a compañeras', note: pendingNote, cents: o.pendingStaff.chicasCents });
  if (o.pendingStaff.camarerosCents > 0) {
    rows.push({ key: 'pending-camareros', label: 'Pago a camareros', note: pendingNote, cents: o.pendingStaff.camarerosCents });
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
  if (o.serviceFeeCents) rows.push({ key: 'service-fee', label: 'Comisión del servicio', note: 'se debe a OxioPay', cents: o.serviceFeeCents });
  return rows;
}

/** La deuda total puede incluir noches anteriores al periodo de las barras. */
function whereNote(m: MoneyMap): string | null {
  const parts: string[] = [];
  const when = moneyMapIsCurrent(m) ? 'ahora' : 'al corte';
  const owed = m.where.owed;
  if (owed) {
    const total = owed.chicasCents + owed.camarerosCents;
    if (total !== m.where.owners.staffCents) parts.push(`deuda total al personal ${when}: ${eurShort(total)}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Un Z recalculado sigue siendo histórico aunque no tenga snapshot congelado. */
export function moneyMapIsCurrent(m: Pick<MoneyMap, 'frozen' | 'scope'>): boolean {
  return !m.frozen && m.scope.kind === 'night' && (m.scope.open || m.scope.nightId === null);
}

/** «De chicas», «De camareros» o «Del personal», según a quién le toque. */
function staffLabel(chicas: number, camareros: number, words: { chicas: string; camareros: string; both: string }): string {
  if (camareros > 0 && chicas > 0) return words.both;
  return camareros > 0 ? words.camareros : words.chicas;
}

function splitSegments(m: MoneyMap): Segment[] {
  const s = m.split;
  return [
    { key: 'venue', label: 'Local', cents: s.venueCents, color: 'var(--np-mm-tuyo)' },
    {
      key: 'staff',
      label: staffLabel(s.chicasCents, s.camarerosCents, { chicas: 'Compañeras', camareros: 'Camareros', both: 'Personal' }),
      cents: s.chicasCents + s.camarerosCents,
      color: 'var(--np-mm-personal)',
    },
    { key: 'fees', label: 'Comisiones', cents: s.commissions.totalCents, color: 'var(--np-mm-comision)' },
  ];
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
    tipsCents: m.sections.find((s) => s.code === MONEY_MAP_TIPS)?.amountCents ?? 0,
    salesCount: m.salesCount,
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
    serviceFee: serviceFeeLine(m),
    sections: rows,
    split: splitSegments(m),
    where: {
      totalCents: m.where.totalCents,
      places: [
        { key: 'bbva', label: 'Banco', cents: m.where.bbvaCents, color: 'var(--np-mm-tarjeta)' },
        { key: 'cash', label: 'Caja esperada', cents: m.where.cashBoxCents, color: 'var(--np-mm-efectivo)' },
      ],
      owners: [
        { key: 'venue', label: 'Tuyo', cents: m.where.owners.venueCents, color: 'var(--np-mm-tuyo)' },
        {
          key: 'staff',
          label: staffLabel(staff - camareros, camareros, { chicas: 'De compañeras', camareros: 'De camareros', both: 'Del personal' }),
          cents: staff,
          color: 'var(--np-mm-personal)',
        },
        // No es el saldo de los clientes: lo que el periodo sumó o restó a ese saldo.
        { key: 'saldo', label: 'Saldo nuevo de clientes (estas fechas)', cents: m.where.owners.saldoCents, color: 'var(--np-mm-saldo)' },
        // Salió o saldrá del banco, aunque Banco enseñe lo cobrado.
        ...(m.where.owners.paidOutCents
          ? [{ key: 'paid', label: 'Ya pagado al personal por banco', cents: m.where.owners.paidOutCents, color: 'var(--np-mm-personal)' }]
          : []),
        ...(m.where.owners.commissionsCents
          ? [{ key: 'fees', label: 'Comisiones (OxioPay y banco)', cents: m.where.owners.commissionsCents, color: 'var(--np-mm-comision)' }]
          : []),
        // La comisión del servicio entró con el resto, pero se debe a OxioPay.
        ...(m.where.owners.oxioPayCents
          ? [{ key: 'oxiopay', label: 'De OxioPay (comisión del servicio)', cents: m.where.owners.oxioPayCents, color: 'var(--np-mm-comision)' }]
          : []),
      ],
      balance: { label: `Saldo real de clientes ${moneyMapIsCurrent(m) ? 'ahora' : 'al corte'}`, cents: m.where.liveSaldoCents },
      note: whereNote(m),
    },
    outflow: outflowRows(m),
  };
}
