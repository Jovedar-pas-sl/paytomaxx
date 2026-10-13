import type { ExportSummary } from '../reports/export-csv';
import type { Incident } from './incident-rules';

/**
 * Textos de Telegram (Fase 1E). Cortos y en texto plano: se leen en el móvil
 * del dueño. Ni datos de clientes ni nombres de las chicas (Telegram es un
 * tercero): importes, horas y qué hacer. El detalle por chica está en el panel.
 */

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

export function incidentMessage(venueName: string, i: Incident): string {
  return [`⚠️ ${venueName}: ${i.title}`, i.detail].join('\n');
}

/** Resumen de las 9:00: la noche anterior del local y lo que queda por mirar. */
export function morningSummaryMessage(
  venueName: string,
  s: ExportSummary,
  openIncidents: number,
  /** Hubo cobros y nadie ha subido el fichero del banco de esa noche. */
  bankFilePending = false,
): string {
  const lines = [
    `☀️ ${venueName} — anoche`,
    `${s.count} ${s.count === 1 ? 'cobro' : 'cobros'} · cobrado ${eur(s.chargedCents)}`,
  ];
  if (s.tipsCents > 0) lines.push(`Propinas: ${eur(s.tipsCents)}`);
  if (s.refundsCents > 0) lines.push(`Devoluciones: −${eur(s.refundsCents)}`);
  lines.push(`Para las chicas: ${eur(s.chicaNetCents)} · para el local: ${eur(s.venueNetCents)}`);
  if (s.perChica.length > 0) lines.push(`Chicas que cobraron: ${s.perChica.length} (detalle en el panel → Noches)`);
  lines.push(
    openIncidents > 0
      ? `Incidencias por mirar: ${openIncidents} (panel → Incidencias)`
      : 'Sin incidencias pendientes',
  );
  if (bankFilePending) lines.push('Cuadre con el banco: sube el fichero de ayer (panel → Banco)');
  return lines.join('\n');
}
