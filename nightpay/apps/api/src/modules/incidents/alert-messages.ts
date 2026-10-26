import { Z_NET_WITHOUT_STAFF_LABEL } from '@nightpay/contracts';
import type { ExportSummary } from '../reports/export-csv';
import type { Incident } from './incident-rules';
import { scopeLabel, type SummaryScope } from './morning-summary';

/**
 * Textos de Telegram (Fase 1E). Cortos y en texto plano: se leen en el móvil
 * del dueño. Ni datos de clientes ni nombres de las chicas (Telegram es un
 * tercero): importes, horas y qué hacer. El detalle por chica está en el panel.
 */

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/**
 * Aviso de una incidencia. Sin nombres (lo de siempre): el detalle sin el
 * nombre de la chica; con `includeNames` (Ajustes → Avisos), tal cual.
 */
export function incidentMessage(venueName: string, i: Incident, opts: { includeNames?: boolean } = {}): string {
  const detail = opts.includeNames ? i.detail : (i.alertDetail ?? i.detail);
  return [`⚠️ ${venueName}: ${i.title}`, detail].join('\n');
}

/**
 * «Cobrado» por partes, como el panel (admin lib/cobrado.ts): ventas con
 * tarjeta, propinas y recargas del saldo (con tarjeta y en efectivo). Un Z de
 * antes del 23-oct-2026 no trae las recargas con tarjeta aparte: sin partes
 * (mejor sin desglose que uno que no cuadre).
 */
function cobradoParts(s: ExportSummary): string | null {
  if (s.walletCardTopUpsCents === undefined) return null;
  const parts = [
    [s.grossCents - s.walletCardTopUpsCents, 'de ventas'],
    [s.tipsCents, 'de propinas'],
    [s.walletCardTopUpsCents + (s.walletCashTopUpsCents ?? 0), 'de recargas'],
    // La paga el cliente encima y se debe a OxioPay (sin ella, no sale).
    [s.serviceFeeCents ?? 0, 'de comisión del servicio'],
  ] as const;
  const shown = parts.filter(([cents]) => cents !== 0).map(([cents, what]) => `${eur(cents)} ${what}`);
  return shown.length > 0 ? shown.join(' + ') : null;
}

/**
 * Resumen de las 9:00: la noche anterior del local y lo que queda por mirar.
 * «Cobrado» es lo del panel (ventas + propinas + recargas, también las de
 * efectivo) con su desglose; «Con tarjeta», lo que pagaron con tarjeta (lo que
 * verá en el banco, antes de comisiones). Antes ponía «N pagos con tarjeta ·
 * cobrado X» y X llevaba las recargas en efectivo.
 */
export function morningSummaryMessage(
  venueName: string,
  s: ExportSummary,
  openIncidents: number,
  /** Hubo cobros y nadie ha subido el fichero del banco de esa noche. */
  bankFilePending = false,
  /** Diferencia de caja al cerrar (contado − esperado); null/0 = cuadró o no se contó. */
  cashDiffCents: number | null = null,
  /** Qué tramo resume: el Z de la noche cerrada o, sin ella, de 08:00 a 08:00. */
  scope: SummaryScope = { kind: 'window' },
): string {
  const parts = cobradoParts(s);
  // La comisión del servicio que pasó por la tarjeta (la de efectivo está en la caja).
  const cardFeeCents = (s.serviceFeeCents ?? 0) - (s.serviceFeeCashCents ?? 0);
  const lines = [
    `☀️ ${venueName} — ${scopeLabel(scope)}`,
    parts ? `Cobrado: ${eur(s.chargedCents)} (${parts})` : `Cobrado: ${eur(s.chargedCents)}`,
    // Los pagos con tarjeta (también las recargas con tarjeta) y sus propinas:
    // lo pagado con el saldo no es dinero nuevo y no cuenta aquí.
    `Con tarjeta: ${s.count} ${s.count === 1 ? 'pago' : 'pagos'} · ${eur(s.grossCents + s.tipsCents + cardFeeCents)}`,
  ];
  if (!parts && s.tipsCents > 0) lines.push(`Propinas: ${eur(s.tipsCents)}`);
  if (s.walletCardTopUpsCount) {
    lines.push(`Recargas con tarjeta: ${s.walletCardTopUpsCount} · ${eur(s.walletCardTopUpsCents ?? 0)}`);
  }
  if (s.walletCashTopUpsCount) {
    const n = s.walletCashTopUpsCount;
    lines.push(`Recargas en efectivo: ${n} · ${eur(s.walletCashTopUpsCents ?? 0)} (en la caja)`);
  }
  if (s.refundsCents > 0) lines.push(`Devoluciones: −${eur(s.refundsCents)}`);
  const oxio = s.serviceFeeNetCents ?? 0;
  if (oxio !== 0 || (s.serviceFeeCents ?? 0) !== 0) {
    const cash = s.serviceFeeCashCents ?? 0;
    lines.push(`Comisión del servicio: ${eur(oxio)} (se debe a OxioPay${cash !== 0 ? `; ${eur(cash)} en la caja` : ''})`);
  }
  // Lo de los camareros (su parte de las copas con invitación, si el local se
  // la da) va aparte: chicas + camareros + el resto = el «Neto (cobrado −
  // devuelto)» del Z. Ese resto se llama como en el panel (Z_NET_WITHOUT_STAFF_LABEL)
  // y no es «Para el local» del mapa del dinero (el reparto de lo vendido):
  // lleva las recargas (saldo de los clientes) y no resta comisiones.
  const camareros = s.camareroNetCents ?? 0;
  lines.push(
    `Para las chicas: ${eur(s.chicaNetCents)}${camareros !== 0 ? ` · para los camareros: ${eur(camareros)}` : ''} · ${Z_NET_WITHOUT_STAFF_LABEL.toLowerCase()}${oxio !== 0 ? ' ni OxioPay' : ''}: ${eur(s.venueNetCents)}`,
  );
  if (s.perChica.length > 0) lines.push(`Chicas que cobraron: ${s.perChica.length} (detalle en el panel → Noches)`);
  if (cashDiffCents) lines.push(cashDiffLine(cashDiffCents));
  lines.push(
    openIncidents > 0
      ? `Incidencias por mirar: ${openIncidents} (panel → Incidencias)`
      : 'Sin incidencias pendientes',
  );
  if (bankFilePending) lines.push('Cuadre con el banco: sube el fichero de ayer (panel → Banco)');
  return lines.join('\n');
}

/** «Caja: faltan 12,50 €» / «Caja: sobran 5,00 €» (contado − esperado al cerrar). */
export function cashDiffLine(diffCents: number): string {
  return `Caja: ${diffCents < 0 ? 'faltan' : 'sobran'} ${eur(Math.abs(diffCents))} al cerrar (panel → Noches)`;
}
