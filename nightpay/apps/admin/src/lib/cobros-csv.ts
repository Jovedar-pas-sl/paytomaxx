// «Descargar» de Cobros: las filas que el panel ya enseña, en un CSV para
// Excel en español. Sin reparto, móvil, IP ni más tarjeta que los 4 últimos
// (lo que trae `methodLabel`). Puro: se prueba sin pantalla (cobros-csv.test.ts).

import { HOME_TOPUP_ORIGIN_LABEL, type CobroRow, type VenueSection } from '@nightpay/contracts';
import { cobroStatus } from './cobro-status';
import { cobroPaidCents } from './cobros-totals';
import { dayInZone } from './dates';
import { sectionChip } from './money-map';

/** Tope de la descarga: los más recientes. */
export const CSV_MAX_ROWS = 5000;

export const COBROS_CSV_HEADER = [
  'Fecha',
  'Hora',
  'Referencia',
  'Sección',
  'Qué',
  'Quién',
  'Cómo pagó',
  'Estado',
  'Importe pagado',
  'Propina',
  'Comisión del servicio',
  'Código',
  'Ref. del banco',
] as const;

// ─── Copiado de apps/api/src/modules/reports/csv.ts (el API no se puede
// importar desde el panel): `text`, `code`, `money` y `toCsv`, tal cual. CSV
// para Excel en español: separador ";", decimales con coma y BOM UTF-8.

/** Celda ya formateada. `text` = escrito por personas (nombres, motivos…). */
type CsvCell = string | number | null | undefined | { text: string | null | undefined };

/**
 * Texto libre: si empieza por = + - @ (o tabulador), Excel lo ejecutaría como
 * fórmula ("CSV injection"). Se le antepone un apóstrofo.
 */
function text(value: string | null | undefined): CsvCell {
  return { text: value };
}

/**
 * Códigos y referencias del banco (A6B, 047215, 1234ABCD5678): se escriben
 * como ="…" para que Excel no los convierta en números ("1E5" → 100000) ni les
 * quite los ceros de la izquierda. Si traen otros caracteres, como texto.
 */
function code(value: string | null | undefined): CsvCell {
  if (!value) return '';
  return /^[A-Za-z0-9-]+$/.test(value) ? `="${value}"` : text(value);
}

function cellToString(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'string') return cell;
  const v = cell.text ?? '';
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function quote(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  return `\uFEFF${rows.map((r) => r.map((c) => quote(cellToString(c))).join(';')).join('\r\n')}\r\n`;
}

/** 1234 → "12,34"; -500 → "-5,00". Sin separador de miles: Excel lo lee como número. */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

// ─── Fin de lo copiado ──────────────────────────────────────────────────

/** dd/mm/aaaa y HH:MM en la hora del local. */
function dateAndTime(iso: string, tz: string): [string, string] {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const of = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return [`${of('day')}/${of('month')}/${of('year')}`, `${of('hour')}:${of('minute')}`];
}

/** El CSV entero (cabecera y una línea por cobro), con las mismas palabras que la tabla. */
export function cobrosCsv(rows: readonly CobroRow[], ctx: { tz: string; sections: readonly VenueSection[] }): string {
  const body = rows.map((row): CsvCell[] => {
    const [day, hour] = dateAndTime(row.createdAt, ctx.tz);
    const section = sectionChip(row, ctx.sections, money).label;
    const what = [row.service, row.invited ? `Invitación a ${row.invited.name}` : null].filter(Boolean).join(' · ');
    return [
      day,
      hour,
      text(row.ref),
      text(section === '—' ? '' : section),
      text(what),
      // Quien cobró, como la tabla.
      text(row.person?.name ?? (row.fromHome ? HOME_TOPUP_ORIGIN_LABEL : '')),
      text(row.methodLabel),
      cobroStatus(row).label,
      money(cobroPaidCents(row)),
      money(row.tipCents),
      money(row.serviceFeeCents ?? 0),
      code(row.confirmationCode),
      code(row.payment?.providerTxId),
    ];
  });
  return toCsv([COBROS_CSV_HEADER, ...body]);
}

/** «cobros-2026-11-15.csv», con el día del local. */
export function csvFileName(now: Date, tz: string): string {
  return `cobros-${dayInZone(now, tz)}.csv`;
}

/**
 * Las filas de la descarga: página a página (200) hasta el final o hasta el
 * tope. `capped`: quedaban más de las que caben. Si una página falla, falla
 * todo (no se guarda un archivo a medias).
 */
export async function collectCobros(
  fetchPage: (cursor: string | undefined) => Promise<{ items: CobroRow[]; nextCursor: string | null }>,
  onProgress: (count: number) => void = () => undefined,
  max: number = CSV_MAX_ROWS,
): Promise<{ rows: CobroRow[]; capped: boolean }> {
  const rows: CobroRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.items);
    if (rows.length >= max) return { rows: rows.slice(0, max), capped: rows.length > max || page.nextCursor !== null };
    if (!page.nextCursor || page.items.length === 0) return { rows, capped: false };
    cursor = page.nextCursor;
    onProgress(rows.length);
  }
}
