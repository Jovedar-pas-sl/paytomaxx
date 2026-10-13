import { cardBrandLabel } from '../payments/card-brand';
import { confirmationCode } from '../payments/pay-redirect';
import { code, date, money, text, time, toCsv, type CsvCell } from './csv';
import {
  CATEGORY_LABEL,
  RECONCILIATION_LABEL,
  STATUS_LABEL,
  WALLET_LABEL,
  captureLabel,
  cardTypeLabel,
  chicaShareCents,
  cobroType,
  methodLabel,
  person,
  type CobroRow,
  type DevolucionRow,
  type LiquidacionRow,
} from './export-rows';
import type { ReportPeriod } from './report-period';

/**
 * Los cuatro CSV para la gestoría (Fase 1C): libro de cobros, devoluciones,
 * pagos a chicas y resumen. Funciones puras: reciben filas, devuelven texto.
 */

// ─── Libro de cobros ────────────────────────────────────────────────────

export function cobrosCsv(rows: ReadonlyArray<CobroRow>, venueName: string): string {
  const header = [
    'Fecha', 'Hora', 'Local', 'Código', 'Concepto', 'Tipo', 'Cobrado por', 'Medio', 'Método',
    'Marca', 'Tipo tarjeta', 'País tarjeta', 'Autorización', 'Pedido banco', 'Importe', 'Propina',
    'Total cobrado', 'Devuelto', 'Neto', 'Parte chica', 'Parte local', 'Estado', 'Referencia NightPay',
  ];
  const body = rows.map((r): CsvCell[] => {
    const charged = r.amountCents + r.tipCents;
    const net = charged - r.refundedCents;
    const chica = chicaShareCents(r);
    return [
      date(r.paidAt),
      time(r.paidAt),
      text(venueName),
      code(confirmationCode(r.id)),
      text(r.serviceName ?? cobroType(r)),
      cobroType(r),
      text(person(r.creatorName, r.creatorEmail)),
      captureLabel(r.captureMethod),
      methodLabel(r),
      cardBrandLabel(r.cardBrand) ?? '',
      cardTypeLabel(r.cardType),
      code(r.cardCountry),
      code(r.authCode),
      code(r.providerTxId),
      money(r.amountCents),
      money(r.tipCents),
      money(charged),
      money(r.refundedCents),
      money(net),
      money(chica),
      money(net - chica),
      STATUS_LABEL[r.status] ?? r.status,
      r.id,
    ];
  });
  return toCsv([header, ...body]);
}

// ─── Devoluciones ───────────────────────────────────────────────────────

export function devolucionesCsv(rows: ReadonlyArray<DevolucionRow>): string {
  const header = [
    'Fecha devolución', 'Importe devuelto', 'Motivo', 'Referencia banco', 'Registrada a mano',
    'Registrada por', 'Fecha del cobro', 'Código del cobro', 'Pedido banco', 'Total cobrado',
    'Cobrado por', 'Descontado a la chica', 'Ya se le había pagado', 'Referencia NightPay',
  ];
  const body = rows.map((r): CsvCell[] => [
    date(r.refundedAt),
    money(r.amountCents),
    text(r.reason),
    text(r.providerRefundId),
    r.registeredManually ? 'Sí' : 'No',
    text(person(r.byName, r.byEmail)),
    date(r.paidAt),
    code(confirmationCode(r.paymentId)),
    code(r.providerTxId),
    money(r.chargedCents),
    text(person(r.creatorName, r.creatorEmail)),
    r.reversedDeltaCents === null ? '' : money(r.reversedDeltaCents),
    r.afterPayout === null ? '' : r.afterPayout ? 'Sí' : 'No',
    r.id,
  ]);
  return toCsv([header, ...body]);
}

// ─── Pagos a chicas ─────────────────────────────────────────────────────

export function liquidacionesCsv(rows: ReadonlyArray<LiquidacionRow>): string {
  const header = [
    'Fecha', 'Chica', 'Importe', 'Cobros incluidos', 'Vía', 'Referencia', 'Conciliación',
    'Pagado por', 'Notas', 'Referencia NightPay',
  ];
  const body = rows.map((r): CsvCell[] => [
    date(r.paidAt),
    text(person(r.operatorName, r.operatorEmail)),
    money(r.totalCents),
    r.earningCount,
    text(r.externalRail),
    text(r.externalTxId),
    RECONCILIATION_LABEL[r.reconciliationStatus] ?? r.reconciliationStatus,
    text(person(r.paidByName, r.paidByEmail)),
    text(r.notes),
    r.id,
  ]);
  return toCsv([header, ...body]);
}

// ─── Resumen ────────────────────────────────────────────────────────────

export interface ChicaSummary {
  name: string;
  count: number;
  chargedCents: number;
  commissionCents: number;
  tipsCents: number;
  reversalsCents: number;
  netCents: number;
  paidCents: number;
}

export interface ExportSummary {
  count: number;
  grossCents: number;
  tipsCents: number;
  chargedCents: number;
  refundsCount: number;
  refundsCents: number;
  netCents: number;
  byType: Array<{ label: string; count: number; chargedCents: number }>;
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  venueTipsCents: number;
  venueNetCents: number;
  payoutsCount: number;
  payoutsCents: number;
  perChica: ChicaSummary[];
}

const TYPE_ORDER = [...Object.values(CATEGORY_LABEL), WALLET_LABEL];

/**
 * Totales del periodo. Cobros por fecha de cobro; devoluciones y pagos a
 * chicas por su propia fecha (una devolución de octubre de un cobro de
 * septiembre cuenta en octubre, como en el banco).
 */
export function summarize(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  liquidaciones: ReadonlyArray<LiquidacionRow>,
): ExportSummary {
  const sum = <T>(xs: ReadonlyArray<T>, f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);
  const grossCents = sum(cobros, (r) => r.amountCents);
  const tipsCents = sum(cobros, (r) => r.tipCents);
  const refundsCents = sum(devoluciones, (r) => r.amountCents);
  const chicaCommissionCents = sum(cobros, (r) => r.commissionCents ?? 0);
  const chicaTipsCents = sum(cobros, (r) => (r.commissionCents === null ? 0 : (r.earningTipCents ?? 0)));
  const chicaReversalsCents = sum(devoluciones, (r) => r.reversedDeltaCents ?? 0);
  const chicaNetCents = chicaCommissionCents + chicaTipsCents - chicaReversalsCents;
  const netCents = grossCents + tipsCents - refundsCents;

  const byType = TYPE_ORDER.map((label) => {
    const rows = cobros.filter((r) => cobroType(r) === label);
    return { label, count: rows.length, chargedCents: sum(rows, (r) => r.amountCents + r.tipCents) };
  }).filter((t) => t.count > 0);

  return {
    count: cobros.length,
    grossCents,
    tipsCents,
    chargedCents: grossCents + tipsCents,
    refundsCount: devoluciones.length,
    refundsCents,
    netCents,
    byType,
    chicaCommissionCents,
    chicaTipsCents,
    chicaReversalsCents,
    chicaNetCents,
    venueTipsCents: tipsCents - chicaTipsCents,
    venueNetCents: netCents - chicaNetCents,
    payoutsCount: liquidaciones.length,
    payoutsCents: sum(liquidaciones, (r) => r.totalCents),
    perChica: perChica(cobros, devoluciones, liquidaciones),
  };
}

function perChica(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  liquidaciones: ReadonlyArray<LiquidacionRow>,
): ChicaSummary[] {
  const byKey = new Map<string, ChicaSummary>();
  const entry = (key: string, name: string): ChicaSummary => {
    const found = byKey.get(key);
    if (found) return found;
    const fresh: ChicaSummary = {
      name, count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversalsCents: 0, netCents: 0, paidCents: 0,
    };
    byKey.set(key, fresh);
    return fresh;
  };
  // Acumuladores locales a esta función: se rellenan y se devuelven copiados.
  for (const r of cobros) {
    if (r.commissionCents === null || !r.earningOperatorEmail) continue;
    const e = entry(r.earningOperatorEmail, person(r.earningOperatorName, r.earningOperatorEmail));
    e.count += 1;
    e.chargedCents += r.amountCents + r.tipCents;
    e.commissionCents += r.commissionCents;
    e.tipsCents += r.earningTipCents ?? 0;
  }
  for (const r of devoluciones) {
    if (!r.reversedDeltaCents || !r.chicaEmail) continue;
    entry(r.chicaEmail, person(r.chicaName, r.chicaEmail)).reversalsCents += r.reversedDeltaCents;
  }
  for (const r of liquidaciones) {
    entry(r.operatorEmail, person(r.operatorName, r.operatorEmail)).paidCents += r.totalCents;
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, netCents: c.commissionCents + c.tipsCents - c.reversalsCents }))
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'es'));
}

export function resumenCsv(args: {
  venueName: string;
  period: ReportPeriod;
  generatedAt: Date;
  summary: ExportSummary;
}): string {
  const s = args.summary;
  const rows: CsvCell[][] = [
    ['Resumen para la gestoría', text(args.venueName)],
    ['Periodo', `${date(args.period.from)} – ${date(new Date(args.period.to.getTime() - 1))}`],
    ['Generado', `${date(args.generatedAt)} ${time(args.generatedAt)}`],
    [],
    ['Concepto', 'Importe (€)', 'Número'],
    ['Cobros (sin propinas)', money(s.grossCents), s.count],
    ['Propinas cobradas', money(s.tipsCents)],
    ['Total cobrado', money(s.chargedCents)],
    ['Devoluciones del periodo', money(-s.refundsCents), s.refundsCount],
    ['Neto cobrado', money(s.netCents)],
    [],
    ['Por tipo de cobro', 'Total cobrado (€)', 'Número'],
    ...s.byType.map((t): CsvCell[] => [t.label, money(t.chargedCents), t.count]),
    [],
    ['Reparto', 'Importe (€)'],
    ['Comisión de las chicas', money(s.chicaCommissionCents)],
    ['Propinas de las chicas', money(s.chicaTipsCents)],
    ['Descontado a las chicas por devoluciones', money(-s.chicaReversalsCents)],
    ['Total para las chicas', money(s.chicaNetCents)],
    ['Propinas del local', money(s.venueTipsCents)],
    ['Total para el local', money(s.venueNetCents)],
    [],
    ['Pagado a chicas en el periodo', money(s.payoutsCents), s.payoutsCount],
    [],
    ['Notas'],
    ['El IVA depende de si el local actúa como intermediario (IVA solo sobre su parte) o como principal (sobre todo lo cobrado). Decídelo con tu asesor.'],
    ['Las propinas van aparte porque normalmente no forman parte de la base del IVA.'],
    ['La comisión del banco no está incluida: sale en el extracto de BBVA.'],
    [],
    ['Por chica', 'Cobros', 'Total cobrado (€)', 'Comisión (€)', 'Propinas (€)', 'Descontado por devoluciones (€)', 'Total para ella (€)', 'Pagado en el periodo (€)'],
    ...s.perChica.map((c): CsvCell[] => [
      text(c.name),
      c.count,
      money(c.chargedCents),
      money(c.commissionCents),
      money(c.tipsCents),
      money(-c.reversalsCents),
      money(c.netCents),
      money(c.paidCents),
    ]),
  ];
  return toCsv(rows);
}
