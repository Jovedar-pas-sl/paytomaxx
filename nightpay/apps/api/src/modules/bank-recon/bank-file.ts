import { madridAt, madridDay } from '../../common/time/madrid';
import type { BankRow, BankRowKind, BankSource } from './bank-match';

/**
 * Lee el fichero de operaciones que se descarga del portal del banco:
 * BBVA/Redsys (TPV virtual) o Paytef (datáfonos).
 *
 * Los portales exportan de formas distintas: CSV con ";" o ",", "Excel" que
 * en realidad es una tabla HTML, Latin-1 o UTF-8, importes "1.234,56" o
 * "10.50 €". Las columnas se reconocen por su nombre (sin acentos ni
 * mayúsculas); si falta alguna imprescindible, el error dice las que hay.
 */

export interface ParsedBankFile {
  rows: BankRow[];
  /** Líneas que no son operaciones (totales, vacías…). */
  skipped: number;
  /** Columna del fichero usada para cada dato (para explicar el cuadre). */
  columns: Partial<Record<Field, string>>;
  periodFrom: string | null;
  periodTo: string | null;
}

export class BankFileError extends Error {}

type Field = 'date' | 'time' | 'amount' | 'reference' | 'type' | 'result' | 'terminal' | 'authCode' | 'currency';

/** Nombres de columna conocidos, ya normalizados (minúsculas, sin acentos ni signos). */
const COMMON_ALIASES: Record<Exclude<Field, 'reference'>, string[]> = {
  date: ['fecha', 'fechaoperacion', 'fechadeoperacion', 'fechahora', 'fechayhora', 'fechatransaccion', 'date', 'datetime'],
  time: ['hora', 'horaoperacion', 'time'],
  amount: [
    // "Importe Euros" antes que "Importe": en Redsys es el importe ya en euros.
    'importeeuros',
    'importe',
    'importeeur',
    'importeoperacion',
    'importetotal',
    'importeeneur',
    'cantidad',
    'amount',
    'total',
  ],
  type: ['tipooperacion', 'tipodeoperacion', 'tipotransaccion', 'tipodetransaccion', 'tipo', 'operationtype', 'type'],
  result: [
    'resultadooperacionycodigo',
    'resultadooperacion',
    'resultado',
    'estado',
    'estadooperacion',
    'codigorespuesta',
    'respuesta',
    'status',
    'result',
  ],
  terminal: ['numerodeterminal', 'numeroterminal', 'terminal', 'nterminal', 'tid', 'idterminal', 'terminalid'],
  authCode: [
    'codigodeautorizacion',
    'codigoautorizacion',
    'codautorizacion',
    'numautorizacion',
    'numerodeautorizacion',
    'autorizacion',
    'authcode',
    'authorisationcode',
    'authorizationcode',
  ],
  currency: ['moneda', 'divisa', 'currency'],
};

const REFERENCE_ALIASES: Record<BankSource, string[]> = {
  REDSYS: [
    'codpedido',
    'codigopedido',
    'codigodepedido',
    'numerodepedido',
    'numeropedido',
    'npedido',
    'numpedido',
    'pedido',
    'dsorder',
    'order',
    'orderid',
    'referencia',
  ],
  PAYTEF: [
    'numerodeoperacion',
    'numerooperacion',
    'noperacion',
    'numoperacion',
    'operacion',
    'paytefoperationnumber',
    'operationnumber',
    'idoperacion',
    'referencia',
  ],
};

const MAX_HEADER_SCAN = 25;

export function parseBankFile(source: BankSource, content: Buffer): ParsedBankFile {
  if (content.length === 0) throw new BankFileError('El fichero está vacío');
  if (content[0] === 0x50 && content[1] === 0x4b) {
    throw new BankFileError(
      'Es un Excel .xlsx: ábrelo y guárdalo como CSV (Archivo → Guardar como → CSV), o descarga el CSV del portal.',
    );
  }
  if (content[0] === 0xd0 && content[1] === 0xcf) {
    throw new BankFileError('Es un Excel antiguo (.xls): ábrelo y guárdalo como CSV, o descarga el CSV del portal.');
  }
  const text = decode(content);
  const table = /<table[\s>]/i.test(text) ? htmlTable(text) : csvTable(text);
  return readTable(source, table);
}

function readTable(source: BankSource, table: string[][]): ParsedBankFile {
  const headerIndex = findHeader(source, table);
  if (headerIndex < 0) {
    const firstRow = table.find((r) => r.some((c) => c.trim()))?.join(' | ') ?? '';
    throw new BankFileError(
      `No encuentro las columnas de fecha e importe${firstRow ? `. Primera línea del fichero: ${firstRow.slice(0, 200)}` : ''}`,
    );
  }
  const header = table[headerIndex]!;
  const cols = mapColumns(source, header);
  const columns: Partial<Record<Field, string>> = {};
  for (const [field, idx] of Object.entries(cols) as Array<[Field, number]>) columns[field] = header[idx]!.trim();

  const rows: BankRow[] = [];
  let skipped = 0;
  for (let i = headerIndex + 1; i < table.length; i++) {
    const cells = table[i]!;
    const parsed = readRow(cells, cols, i + 1);
    if (parsed) rows.push(parsed);
    else skipped++;
  }
  if (rows.length === 0) throw new BankFileError('El fichero no tiene operaciones');

  const days = rows.filter((r) => r.at).map((r) => madridDay(r.at!));
  days.sort();
  return {
    rows,
    skipped,
    columns,
    periodFrom: days[0] ?? null,
    periodTo: days[days.length - 1] ?? null,
  };
}

function findHeader(source: BankSource, table: string[][]): number {
  for (let i = 0; i < Math.min(table.length, MAX_HEADER_SCAN); i++) {
    const cols = mapColumns(source, table[i]!);
    if (cols.amount !== undefined && (cols.date !== undefined || cols.reference !== undefined)) return i;
  }
  return -1;
}

function mapColumns(source: BankSource, header: string[]): Partial<Record<Field, number>> {
  const norm = header.map(normalizeHeader);
  const found: Partial<Record<Field, number>> = {};
  const aliases: Record<Field, string[]> = { ...COMMON_ALIASES, reference: REFERENCE_ALIASES[source] };
  // Primero los nombres exactos; después los que empiezan igual ("importe (eur)").
  for (const pass of ['exact', 'prefix'] as const) {
    for (const [field, names] of Object.entries(aliases) as Array<[Field, string[]]>) {
      if (found[field] !== undefined) continue;
      for (const name of names) {
        const idx = norm.findIndex(
          (h, i) => !Object.values(found).includes(i) && (pass === 'exact' ? h === name : h.startsWith(name)),
        );
        if (idx >= 0) {
          found[field] = idx;
          break;
        }
      }
    }
  }
  return found;
}

function readRow(cells: string[], cols: Partial<Record<Field, number>>, line: number): BankRow | null {
  const get = (f: Field) => (cols[f] !== undefined ? (cells[cols[f]!] ?? '').trim() : '');
  const amount = parseAmount(get('amount'));
  if (amount === null) return null;
  const at = parseDateTime(get('date'), get('time'));
  if (!at && cols.date !== undefined) return null; // línea de totales u otra sin fecha
  const typeText = get('type');
  let kind = parseKind(typeText);
  if (amount < 0 && kind === 'SALE') kind = 'REFUND';
  const resultText = get('result');
  const { approved, authCode: authFromResult } = parseResult(resultText);
  const reference = get('reference') || null;
  return {
    line,
    at,
    kind,
    approved,
    amountCents: Math.abs(amount),
    reference,
    terminal: get('terminal') || null,
    authCode: get('authCode') || authFromResult,
  };
}

export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // "Nº", "N.º", "N°", "No." → "numero" ("nombre" no se toca).
    .replace(/\bn\.?\s*(?:[º°]|o\.)\s*/g, 'numero')
    .replace(/[^a-z0-9]/g, '');
}

/** "1.234,56", "1234.56", "10,50 €", "-10,50", "EUR 10.5" → céntimos (con signo). */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[€\s]|EUR/gi, '');
  if (!s || !/\d/.test(s)) return null;
  const negative = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  s = s.replace(/[-+()]/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) {
    // "1,234.56" o "10.50"; un solo punto con 3 decimales ("1.234") es de miles.
    const decimals = s.length - lastDot - 1;
    normalized = decimals === 3 && lastComma < 0 && (s.match(/\./g) ?? []).length === 1 ? s.replace('.', '') : s.replace(/,/g, '');
  } else normalized = s;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** "13/10/2026", "13-10-2026 23:15", "2026-10-13T23:15:00" + "23:15:08" → instante (hora de Madrid). */
export function parseDateTime(dateRaw: string, timeRaw: string): Date | null {
  const d = dateRaw.trim();
  let day: string | null = null;
  let rest = '';
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(.*)$/.exec(d);
  if (m) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    day = `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    rest = m[4]!;
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(d))) {
    day = `${m[1]}-${m[2]}-${m[3]}`;
    rest = m[4]!;
  }
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(timeRaw.trim() || rest);
  const hh = time ? Number(time[1]) : 0;
  const mm = time ? Number(time[2]) : 0;
  const ss = time && time[3] ? Number(time[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return new Date(madridAt(day, hh).getTime() + (mm * 60 + ss) * 1000);
}

function parseKind(raw: string): BankRowKind {
  const t = normalizeHeader(raw);
  if (!t) return 'SALE';
  if (/devol|refund|abono|reembols/.test(t)) return 'REFUND';
  if (/anul|cancel|void|retroc/.test(t)) return 'VOID';
  if (/preautoriz|preauth|confirmacionpreaut/.test(t)) return 'OTHER';
  if (/autoriz|venta|pago|compra|cargo|sale|purchase|payment|confirmacion/.test(t)) return 'SALE';
  return 'OTHER';
}

/**
 * "Autorizada 123456", "Denegada 190", "0000", "OK", "Aprobada"…
 * Redsys: códigos 0000–0099 = autorizada; el número tras "Autorizada" es la autorización.
 */
function parseResult(raw: string): { approved: boolean; authCode: string | null } {
  const t = raw.trim();
  if (!t) return { approved: true, authCode: null };
  const n = normalizeHeader(t);
  const auth = /autorizad[ao]\s*[:-]?\s*([A-Z0-9]{4,8})/i.exec(t)?.[1] ?? null;
  if (/deneg|rechaz|error|fallid|ko$|^ko|fail|declin|anulad|cancelad|sinautoriz/.test(n)) return { approved: false, authCode: null };
  if (/^\d{1,4}$/.test(t)) return { approved: Number(t) < 100, authCode: null };
  if (/autoriz|aprob|acept|correct|^ok|exito|success|approv|pagad/.test(n)) return { approved: true, authCode: auth };
  return { approved: false, authCode: null };
}

function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '');
  // Si no es UTF-8 válido (portales en Latin-1), se lee como Windows-1252.
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

function csvTable(text: string): string[][] {
  const lines = text.split(/\r\n|\n|\r/);
  const sample = lines.slice(0, MAX_HEADER_SCAN).join('\n');
  const delimiter = ([';', '\t', ','] as const)
    .map((d) => ({ d, n: sample.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;
  return parseCsv(text, delimiter);
}

/** CSV con comillas ("a;b" y "" dentro de comillas). */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Excel en CSV pone ="123" para que no se coma los ceros.
  return rows.map((r) => r.map((c) => c.replace(/^="(.*)"$/, '$1')));
}

/** "Excel" que en realidad es una tabla HTML (muy común en portales bancarios). */
function htmlTable(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]!))) cells.push(htmlText(cm[1]!));
    rows.push(cells);
  }
  return rows;
}

/** Las entidades que salen en los portales españoles. */
const HTML_ENTITIES: Record<string, string> = {
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
  uuml: 'ü',
  ccedil: 'ç',
  ordm: 'º',
  ordf: 'ª',
  deg: '°',
  euro: '€',
};

function htmlText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
