import { cardBrandLabel } from '../payments/card-brand';
import { confirmationCode } from '../payments/pay-redirect';
import { code, date, money, text, time, toCsv, type CsvCell } from './csv';
import {
  RECONCILIATION_LABEL,
  STATUS_LABEL,
  camareroShareCents,
  captureLabel,
  cardTypeLabel,
  categoryLabel,
  chicaShareCents,
  cobroChargedCents,
  cobroSections,
  cobroServiceFeeNetCents,
  cobroType,
  isChicaPart,
  methodLabel,
  person,
  refundStaff,
  type CobroRow,
  type DevolucionRow,
  type LiquidacionRow,
  type PagoSaldoRow,
  type RecargaEfectivoRow,
  type SectionLabeler,
} from './export-rows';
import type { ExportSummary } from './export-summary';
import type { ReportPeriod } from './report-period';
import { BRAND_NAME } from '../../common/brand';
import { HOME_TOPUP_ORIGIN_LABEL, SERVICE_FEE_LABEL } from '@nightpay/contracts';

/**
 * Los cuatro CSV para la gestoría (Fase 1C): libro de cobros, devoluciones,
 * pagos al personal y resumen. Funciones puras: reciben filas, devuelven
 * texto. En una «Copa con invitación», la parte de la chica es suya (no del
 * local) y la del camarero, solo si el local se la da.
 *
 * «Comisión del servicio» (service-fee.ts): sus columnas van AL FINAL y solo
 * si alguna fila la lleva. Las columnas de siempre no se mueven (las
 * plantillas de importación de la gestoría van por posición) y, sin ella, el
 * CSV es el de antes. Con ella, «Total cobrado» la incluye y «Parte local»
 * la descuenta (es de OxioPay).
 *
 * «Origen» del libro de cobros, igual: la última y solo si alguna fila es una
 * carga con el enlace del local («Desde casa»; vacía en el resto). Nada del
 * cliente (ni su contacto ni la clave de la carga) va en ningún CSV.
 */

// ─── Libro de cobros ────────────────────────────────────────────────────

/** `labelOf`: los nombres de sección del local (venueSectionLabeler), como en el panel. */
export function cobrosCsv(rows: ReadonlyArray<CobroRow>, venueName: string, labelOf: SectionLabeler = categoryLabel): string {
  const withFee = rows.some((r) => (r.serviceFeeCents ?? 0) !== 0 || (r.refundedServiceFeeCents ?? 0) !== 0);
  const withOrigin = rows.some((r) => r.fromHome === true);
  const header = [
    'Fecha', 'Hora', 'Local', 'Código', 'Concepto', 'Tipo', 'Cobrado por', 'Medio', 'Método',
    'Marca', 'Tipo tarjeta', 'País tarjeta', 'Autorización', 'Pedido banco', 'Importe', 'Propina',
    'Total cobrado', 'Devuelto', 'Neto', 'Parte chica', 'Parte camarero', 'Parte local', 'Estado', `Referencia ${BRAND_NAME}`,
    'Por sección',
    // La «Comisión del servicio» que pagó el cliente encima y lo que queda de ella (se debe a OxioPay).
    ...(withFee ? [SERVICE_FEE_LABEL, `Parte ${BRAND_NAME}`] : []),
    // Las cargas con el enlace del local («Cargar saldo antes de llegar»), detrás de todo.
    ...(withOrigin ? ['Origen'] : []),
  ];
  const body = rows.map((r): CsvCell[] => {
    const charged = cobroChargedCents(r);
    const net = charged - r.refundedCents;
    const chica = chicaShareCents(r);
    const camarero = camareroShareCents(r);
    // Lo de OxioPay: la comisión del servicio que no se devolvió.
    const oxio = cobroServiceFeeNetCents(r);
    return [
      date(r.paidAt),
      time(r.paidAt),
      text(venueName),
      code(confirmationCode(r.id)),
      text(r.serviceName ?? cobroType(r, labelOf)),
      text(cobroType(r, labelOf)),
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
      money(camarero),
      money(net - chica - camarero - oxio),
      STATUS_LABEL[r.status] ?? r.status,
      r.id,
      text(bySection(r, labelOf)),
      ...(withFee ? [money(r.serviceFeeCents ?? 0), money(oxio)] : []),
      ...(withOrigin ? [r.fromHome === true ? HOME_TOPUP_ORIGIN_LABEL : ''] : []),
    ];
  });
  return toCsv([header, ...body]);
}

/** «Servicios 120,00 · Habitaciones 30,00» (por líneas; sin propina). Recargas: vacío. */
function bySection(r: CobroRow, labelOf: SectionLabeler): string {
  return [...cobroSections(r)].map(([code, cents]) => `${labelOf(code)} ${money(cents)}`).join(' · ');
}

// ─── Devoluciones ───────────────────────────────────────────────────────

export function devolucionesCsv(rows: ReadonlyArray<DevolucionRow>): string {
  const withFee = rows.some((r) => (r.serviceFeeCents ?? 0) !== 0);
  const header = [
    'Fecha devolución', 'Importe devuelto', 'Motivo', 'Referencia banco', 'Registrada a mano',
    'Registrada por', 'Fecha del cobro', 'Código del cobro', 'Pedido banco', 'Total cobrado',
    'Cobrado por', 'Descontado a la chica', 'Ya se le había pagado', 'Descontado al camarero', `Referencia ${BRAND_NAME}`,
    // La parte del importe devuelto que era comisión del servicio (ya está en «Importe devuelto»).
    ...(withFee ? [`${SERVICE_FEE_LABEL} devuelta`] : []),
  ];
  const body = rows.map((r): CsvCell[] => {
    const parts = refundStaff(r);
    const chicas = parts.filter(isChicaPart);
    const camareros = parts.filter((x) => !isChicaPart(x));
    const sum = (xs: typeof parts) => xs.reduce((a, x) => a + x.reversedDeltaCents, 0);
    return [
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
      chicas.length === 0 ? '' : money(sum(chicas)),
      chicas.length === 0 ? '' : chicas.some((x) => x.afterPayout) ? 'Sí' : 'No',
      camareros.length === 0 ? '' : money(sum(camareros)),
      r.id,
      ...(withFee ? [money(r.serviceFeeCents ?? 0)] : []),
    ];
  });
  return toCsv([header, ...body]);
}

// ─── Pagos al personal (chicas y, si tienen parte de las invitaciones, camareros) ──

/** «Chica» o «Camarero» (su parte de las copas con invitación). */
export function payeeLabel(role: string | null | undefined): string {
  return role === 'WAITER' ? 'Camarero' : 'Chica';
}

export function liquidacionesCsv(rows: ReadonlyArray<LiquidacionRow>): string {
  const header = [
    'Fecha', 'Persona', 'Puesto', 'Importe', 'Cobros incluidos', 'Vía', 'Referencia', 'Conciliación',
    'Pagado por', 'Notas', `Referencia ${BRAND_NAME}`,
  ];
  const body = rows.map((r): CsvCell[] => [
    date(r.paidAt),
    text(person(r.operatorName, r.operatorEmail)),
    payeeLabel(r.role),
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

// ─── Recargas en efectivo y saldo devuelto (para la gestoría) ─────────────

/**
 * Las recargas del saldo en efectivo, línea a línea (las facturas
 * simplificadas de la gestoría): las anulaciones van como líneas negativas
 * que dicen qué recarga anulan. La suma es la del resumen.
 */
export function recargasEfectivoCsv(rows: ReadonlyArray<RecargaEfectivoRow>): string {
  const withFee = rows.some((r) => (r.serviceFeeCents ?? 0) !== 0);
  const header = [
    'Fecha', 'Hora', 'Importe', 'Tipo', 'Anula a', 'Motivo', 'Saldo nuevo', 'Cobrada por', 'Datáfono',
    `Referencia ${BRAND_NAME}`,
    // «Importe» es el saldo; encima, la comisión del servicio (se debe a OxioPay) y lo que pagó el cliente.
    ...(withFee ? [SERVICE_FEE_LABEL, 'Cobrado'] : []),
  ];
  const body = rows.map((r): CsvCell[] => [
    date(r.at),
    time(r.at),
    money(r.amountCents),
    r.voidOfId ? 'Anulación' : 'Recarga',
    text(r.voidOfId ?? null),
    text(r.reason ?? null),
    r.voidOfId ? '' : r.createdWallet ? 'Sí' : 'No',
    text(person(r.takenByName, r.takenByEmail)),
    text(r.terminalLabel),
    r.id,
    ...(withFee ? [money(r.serviceFeeCents ?? 0), money(r.amountCents + (r.serviceFeeCents ?? 0))] : []),
  ]);
  return toCsv([header, ...body]);
}

/** El saldo devuelto a los clientes (en efectivo y a la tarjeta), línea a línea. */
export function saldoDevueltoCsv(rows: ReadonlyArray<PagoSaldoRow>): string {
  const header = ['Fecha', 'Hora', 'Importe', 'Vía', 'Referencia banco', 'Devuelto por', `Referencia ${BRAND_NAME}`];
  const body = rows.map((r): CsvCell[] => [
    date(r.at),
    time(r.at),
    money(r.amountCents),
    r.method === 'CASH' ? 'Efectivo' : 'Tarjeta',
    text(r.bankReference ?? null),
    text(person(r.paidByName, r.paidByEmail)),
    r.id,
  ]);
  return toCsv([header, ...body]);
}

// ─── Resumen ────────────────────────────────────────────────────────────

// Las cuentas del resumen viven en export-summary.ts (también las usan las
// noches y el aviso de la mañana); se reexportan aquí.
export { summarize, type ChicaSummary, type ExportSummary, type TypeLine } from './export-summary';

export function resumenCsv(args: {
  venueName: string;
  period: ReportPeriod;
  generatedAt: Date;
  summary: ExportSummary;
}): string {
  const s = args.summary;
  return toCsv([
    ['Resumen para la gestoría', text(args.venueName)],
    ['Periodo', `${date(args.period.from)} – ${date(new Date(args.period.to.getTime() - 1))}`],
    ['Generado', `${date(args.generatedAt)} ${time(args.generatedAt)}`],
    [],
    ...totalRows(s),
    [],
    ['Por tipo de cobro', 'Total cobrado (€)', 'Número'],
    ...s.byType.map((t): CsvCell[] => [text(t.label), money(t.chargedCents), t.count]),
    [],
    ...saldoRows(s),
    [],
    ...repartoRows(s),
    [],
    ...NOTES,
    ...(hasServiceFee(s) ? [SERVICE_FEE_NOTE] : []),
    [],
    ...perChicaRows(s),
  ]);
}

function totalRows(s: ExportSummary): CsvCell[][] {
  return [
    ['Concepto', 'Importe (€)', 'Número'],
    ['Cobros (sin propinas)', money(s.grossCents), s.count],
    ['Propinas cobradas', money(s.tipsCents)],
    ['Recargas del saldo en efectivo', money(s.walletCashTopUpsCents ?? 0), s.walletCashTopUpsCount ?? 0],
    ...(hasServiceFee(s) ? [[`${SERVICE_FEE_LABEL} cobrada`, money(s.serviceFeeCents ?? 0), serviceFeeCount(s)] as CsvCell[]] : []),
    ['Total cobrado', money(s.chargedCents)],
    ['Devoluciones del periodo', money(-s.refundsCents), s.refundsCount],
    ...(hasServiceFee(s) ? [[`${SERVICE_FEE_LABEL} devuelta`, money(-(s.serviceFeeRefundedCents ?? 0))] as CsvCell[]] : []),
    ['Saldo devuelto en efectivo', money(-s.walletCashPayoutsCents), s.walletCashPayoutsCount],
    ['Neto cobrado', money(s.netCents)],
  ];
}

/** ¿Hubo comisión del servicio en el periodo? Sin ella, el resumen es el de siempre. */
function hasServiceFee(s: ExportSummary): boolean {
  return (s.serviceFeeCents ?? 0) !== 0 || (s.serviceFeeRefundedCents ?? 0) !== 0;
}

/** Cuántos cobros y recargas la llevaron (la línea «por tipo» de la comisión). */
function serviceFeeCount(s: ExportSummary): number {
  return s.byType.find((t) => t.label === SERVICE_FEE_LABEL)?.count ?? 0;
}

const SERVICE_FEE_NOTE: CsvCell[] = [
  `La comisión del servicio la paga el cliente encima del precio y se debe a ${BRAND_NAME}: el dinero entra entero al local (su banco o su caja), pero no es del local. Va aparte del IVA del local; la parte de las chicas se calcula sobre el consumo, nunca sobre ella.`,
];

/** El saldo de los clientes: consumos (no son dinero nuevo) y lo que se les devolvió. */
function saldoRows(s: ExportSummary): CsvCell[][] {
  return [
    ['Saldo de los clientes', 'Importe (€)', 'Número'],
    ['Consumos del saldo', money(s.consumptionsCents), s.consumptionsCount],
    ...s.saldoByType.map((t): CsvCell[] => [text(t.label), money(t.chargedCents), t.count]),
    ['Devuelto en efectivo (restado arriba)', money(-s.walletCashPayoutsCents), s.walletCashPayoutsCount],
    ['Devuelto a la tarjeta (ya está en devoluciones)', money(-s.walletCardPayoutsCents), s.walletCardPayoutsCount],
  ];
}

function repartoRows(s: ExportSummary): CsvCell[][] {
  // Los camareros solo tienen parte si el local se la da (Ajustes → Invitaciones): sin ella, ni se nombran.
  const camareros = (s.camareroCommissionCents ?? 0) !== 0 || (s.camareroReversalsCents ?? 0) !== 0;
  const camareroPaid = (s.camareroPayoutsCount ?? 0) > 0;
  return [
    ['Reparto', 'Importe (€)'],
    ['Comisión de las chicas', money(s.chicaCommissionCents)],
    ['Propinas de las chicas', money(s.chicaTipsCents)],
    ['Descontado a las chicas por devoluciones', money(-s.chicaReversalsCents)],
    ['Total para las chicas', money(s.chicaNetCents)],
    ...(camareros ? [['Total para los camareros (copas con invitación)', money(s.camareroNetCents ?? 0)] as CsvCell[]] : []),
    ...(hasServiceFee(s) ? [[`${SERVICE_FEE_LABEL} · se debe a ${BRAND_NAME}`, money(s.serviceFeeNetCents ?? 0)] as CsvCell[]] : []),
    ['Propinas del local', money(s.venueTipsCents)],
    ['Total para el local', money(s.venueNetCents)],
    [],
    ['Pagado a chicas en el periodo', money(s.payoutsCents), s.payoutsCount],
    ...(camareroPaid ? [['Pagado a camareros en el periodo', money(s.camareroPayoutsCents ?? 0), s.camareroPayoutsCount ?? 0] as CsvCell[]] : []),
  ];
}

const NOTES: CsvCell[][] = [
  ['Notas'],
  ['El IVA depende de si el local actúa como intermediario (IVA solo sobre su parte) o como principal (sobre todo lo cobrado). Decídelo con tu asesor.'],
  ['Las propinas van aparte porque normalmente no forman parte de la base del IVA.'],
  ['Las recargas de saldo (con tarjeta o en efectivo) cuentan como cobradas al cargarlas; lo que se devuelve del saldo resta (en efectivo, arriba; a la tarjeta, en las devoluciones). Los consumos del saldo no son dinero nuevo.'],
  ['La comisión del banco no está incluida: sale en el extracto de BBVA.'],
];

function perChicaRows(s: ExportSummary): CsvCell[][] {
  return [
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
}
