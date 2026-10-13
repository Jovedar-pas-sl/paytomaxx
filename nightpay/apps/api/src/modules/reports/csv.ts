/**
 * CSV para Excel en español: separador ";", decimales con coma y BOM UTF-8
 * (sin él, Excel rompe los acentos). Se abre con doble clic.
 */

/** Celda ya formateada. `text` = escrito por personas (nombres, motivos…). */
export type CsvCell = string | number | null | undefined | { text: string | null | undefined };

/**
 * Texto libre: si empieza por = + - @ (o tabulador), Excel lo ejecutaría como
 * fórmula ("CSV injection"). Se le antepone un apóstrofo.
 */
export function text(value: string | null | undefined): CsvCell {
  return { text: value };
}

/**
 * Códigos y referencias del banco (A6B, 047215, 1234ABCD5678): se escriben
 * como ="…" para que Excel no los convierta en números ("1E5" → 100000) ni les
 * quite los ceros de la izquierda. Si traen otros caracteres, como texto.
 */
export function code(value: string | null | undefined): CsvCell {
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

export function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  return `\uFEFF${rows.map((r) => r.map((c) => quote(cellToString(c))).join(';')).join('\r\n')}\r\n`;
}

/** 1234 → "12,34"; -500 → "-5,00". Sin separador de miles: Excel lo lee como número. */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** dd/mm/aaaa en hora de Madrid. */
export function date(d: Date | null | undefined): string {
  return d ? DATE_FMT.format(d) : '';
}

/** HH:MM en hora de Madrid. */
export function time(d: Date | null | undefined): string {
  return d ? TIME_FMT.format(d) : '';
}
