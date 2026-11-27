// El selector de fechas del panel (SelectorNoches): por noches, como cuenta el
// Z, o por días naturales de Madrid (el calendario y los informes).
//
// Una noche cuenta como su Z: desde el cierre de la anterior (la siguiente en
// fetchNights(), que va de nueva a vieja; si no hay, su apertura) hasta su
// cierre, o ahora si sigue abierta. Su nombre es el día de Madrid de la
// apertura menos 8 h (abierta a la 01:00 del domingo: la del sábado).

import type { MoneyMapQuery } from '@nightpay/contracts';
import { MADRID_TIMEZONE, madridToday, presetRange } from './dates';

export type ClavePeriodo = 'esta-noche' | 'anoche' | 'finde' | '7noches' | 'mes' | 'mes-pasado' | 'trimestre-pasado' | 'ano';

export type Periodo = { clave: ClavePeriodo } | { clave: 'noche'; id: string } | { clave: 'fechas'; desde: string; hasta: string };

/** Lo que se ofrece en el selector. */
export type OpcionPeriodo = Periodo['clave'];

/** Cobros y el mapa del dinero. */
export const PERIODOS_NOCHE: readonly OpcionPeriodo[] = ['esta-noche', 'anoche', 'finde', '7noches', 'noche', 'mes', 'mes-pasado', 'fechas'];
/** Informes: solo el calendario (como los pide la gestoría). */
export const PERIODOS_INFORMES: readonly OpcionPeriodo[] = ['mes', 'mes-pasado', 'trimestre-pasado', 'ano', 'fechas'];

export const NOMBRE_PERIODO: Readonly<Record<OpcionPeriodo, string>> = {
  'esta-noche': 'Esta noche',
  anoche: 'Anoche',
  finde: 'Este fin de semana',
  '7noches': 'Últimas 7 noches',
  noche: 'Otra noche…',
  mes: 'Este mes',
  'mes-pasado': 'Mes pasado',
  'trimestre-pasado': 'Trimestre pasado',
  ano: 'Este año',
  fechas: 'Elegir fechas',
};

/** Lo que hace falta de cada noche de fetchNights(). */
export interface NocheLista {
  id: string;
  openedAt: string;
  closedAt: string | null;
}

export interface VentanaNoche {
  /** null: «Esta noche» sin noche abierta. */
  id: string | null;
  /** Su día («AAAA-MM-DD»). */
  nombre: string;
  openedAt: string | null;
  closedAt: string | null;
  fromAt: string;
  toAt: string | null;
}

export type PeriodoResuelto =
  | { tipo: 'noches'; noches: VentanaNoche[]; ids: string[]; fromAt: string; toAt: string | null; desdeCierre?: boolean }
  | { tipo: 'dias'; desde: string; hasta: string }
  | { tipo: 'vacio' };

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Lo más largo que admite el API (como los informes). */
export const MAX_DIAS = 366;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

// ─── Madrid ──────────────────────────────────────────────────────────

const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const HORA_FMT = new Intl.DateTimeFormat('es-ES', { timeZone: MADRID_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Minutos que Madrid va por delante de UTC en ese instante (60 o 120). */
function madridOffsetMinutes(d: Date): number {
  const p = Object.fromEntries(PARTS_FMT.formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** La hora `hour`:00 del día «AAAA-MM-DD» en Madrid (copia de madridAt del API, con sus cambios de hora). */
function madridAt(day: string, hour: number): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utcWall = Date.UTC(y, m - 1, d, hour);
  // Los cambios de hora son a las 02:00/03:00, nunca a las 00:00 ni a las 08:00.
  const guess = new Date(utcWall - madridOffsetMinutes(new Date(utcWall)) * 60_000);
  return new Date(utcWall - madridOffsetMinutes(guess) * 60_000);
}

/** Las 00:00 de Madrid de ese día. */
export function inicioDiaMadrid(day: string): Date {
  return madridAt(day, 0);
}

function sumarDias(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Las últimas 08:00 de Madrid que ya pasaron (como lastNightCutoff del API). */
function ultimas8(now: Date): Date {
  const today = madridAt(madridToday(now), 8);
  return today <= now ? today : madridAt(sumarDias(madridToday(now), -1), 8);
}

/** El día de una noche: el de Madrid de su apertura menos 8 h. */
export function nombreNoche(iso: string): string {
  return madridToday(new Date(Date.parse(iso) - 8 * HOUR));
}

function diaReal(day: string): boolean {
  if (!DIA.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Unas fechas valen: días de verdad, en orden, hasta hoy y como mucho 366 días. */
export function fechasValidas(desde: string, hasta: string, hoy: string): boolean {
  if (!diaReal(desde) || !diaReal(hasta) || hasta < desde || hasta > hoy) return false;
  return (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DAY + 1 <= MAX_DIAS;
}

// ─── Resolver ────────────────────────────────────────────────────────

function ventanas(nights: readonly NocheLista[]): VentanaNoche[] {
  return nights.map((n, i) => ({
    id: n.id,
    nombre: nombreNoche(n.openedAt),
    openedAt: n.openedAt,
    closedAt: n.closedAt,
    fromAt: nights[i + 1]?.closedAt ?? n.openedAt,
    toAt: n.closedAt,
  }));
}

/** Unas noches (de nueva a vieja): desde el inicio de la más vieja hasta el cierre de la más nueva. */
function deNoches(noches: VentanaNoche[]): PeriodoResuelto {
  if (noches.length === 0) return { tipo: 'vacio' };
  return { tipo: 'noches', noches, ids: noches.map((n) => n.id!), fromAt: noches[noches.length - 1]!.fromAt, toAt: noches[0]!.toAt };
}

export function resolverPeriodo(periodo: Periodo, nights: readonly NocheLista[], now: Date = new Date()): PeriodoResuelto {
  const all = ventanas(nights);
  switch (periodo.clave) {
    case 'esta-noche': {
      const open = all.find((n) => n.closedAt === null);
      if (open) return deNoches([open]);
      const last = all.find((n) => n.closedAt !== null);
      const fromAt = last?.closedAt ?? ultimas8(now).toISOString();
      const nombre = nombreNoche(now.toISOString());
      return { tipo: 'noches', noches: [{ id: null, nombre, openedAt: null, closedAt: null, fromAt, toAt: null }], ids: [], fromAt, toAt: null, desdeCierre: Boolean(last) };
    }
    case 'anoche':
      return deNoches(all.filter((n) => n.closedAt !== null).slice(0, 1));
    case 'finde': {
      // De viernes a domingo: el que está en curso (de viernes a domingo) o el último.
      const hoy = nombreNoche(now.toISOString());
      const weekday = new Date(`${hoy}T00:00:00Z`).getUTCDay();
      const viernes = sumarDias(hoy, -((weekday + 2) % 7));
      const domingo = sumarDias(viernes, 2);
      return deNoches(all.filter((n) => n.nombre >= viernes && n.nombre <= domingo));
    }
    case '7noches':
      return deNoches(all.slice(0, 7));
    case 'noche':
      return deNoches(all.filter((n) => n.id === periodo.id));
    case 'fechas':
      return { tipo: 'dias', desde: periodo.desde, hasta: periodo.hasta };
    case 'mes':
      return dias(presetRange('thisMonth', now));
    case 'mes-pasado':
      return dias(presetRange('lastMonth', now));
    case 'trimestre-pasado':
      return dias(presetRange('lastQuarter', now));
    case 'ano':
      return dias(presetRange('thisYear', now));
  }
}

function dias(r: { from: string; to: string }): PeriodoResuelto {
  return { tipo: 'dias', desde: r.from, hasta: r.to };
}

/** Lo que se pide al mapa del dinero; null: no se pide (no hubo noches). */
export function mapaQuery(periodo: Periodo, r: PeriodoResuelto): MoneyMapQuery | null {
  if (r.tipo === 'vacio') return null;
  if (periodo.clave === 'esta-noche') return {};
  if (r.tipo === 'dias') return { from: r.desde, to: r.hasta };
  if (r.ids.length === 1) return { night: r.ids[0]! };
  return r.toAt ? { fromAt: r.fromAt, toAt: r.toAt } : { fromAt: r.fromAt };
}

/** El filtro de Cobros: siempre from/to (instantes), nunca nightId; null: no se pide. */
export function cobrosVentana(r: PeriodoResuelto): { from: string; to?: string } | null {
  if (r.tipo === 'vacio') return null;
  if (r.tipo === 'dias') {
    return { from: inicioDiaMadrid(r.desde).toISOString(), to: inicioDiaMadrid(sumarDias(r.hasta, 1)).toISOString() };
  }
  return r.toAt ? { from: r.fromAt, to: r.toAt } : { from: r.fromAt };
}

// ─── Textos ──────────────────────────────────────────────────────────

const SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «sáb 14». */
export function diaCorto(day: string): string {
  return `${SEMANA[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))}`;
}

function hora(iso: string): string {
  return HORA_FMT.format(new Date(iso));
}

function lista(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** «Del 1 al 25 de noviembre», «Del 20 de octubre al 3 de noviembre» (con el año si no es este). */
function rangoDias(desde: string, hasta: string, hoy: string): string {
  const [y1, m1, d1] = desde.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = hasta.split('-').map(Number) as [number, number, number];
  const year = (y: number) => (String(y) === hoy.slice(0, 4) ? '' : ` de ${y}`);
  if (desde === hasta) return `El ${d1} de ${MESES[m1 - 1]}${year(y1)}`;
  if (y1 !== y2) return `Del ${d1} de ${MESES[m1 - 1]} de ${y1} al ${d2} de ${MESES[m2 - 1]} de ${y2}`;
  if (m1 === m2) return `Del ${d1} al ${d2} de ${MESES[m2 - 1]}${year(y2)}`;
  return `Del ${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]}${year(y2)}`;
}

/** La línea de debajo del selector (14 px). */
export function lineaPeriodo(r: PeriodoResuelto, now: Date = new Date()): string {
  if (r.tipo === 'vacio') return 'No abriste ninguna noche esos días';
  if (r.tipo === 'dias') return `${rangoDias(r.desde, r.hasta, madridToday(now))}, por días naturales`;
  const [first] = r.noches;
  if (r.noches.length === 1 && first) {
    if (first.id === null) {
      return r.desdeCierre ? `Sin noche abierta: desde el último cierre, a las ${hora(r.fromAt)}` : `Sin noche abierta: desde las ${hora(r.fromAt)}`;
    }
    const dia = diaCorto(first.nombre);
    return first.closedAt ? `Noche del ${dia}, de ${hora(first.openedAt!)} a ${hora(first.closedAt)}` : `Noche del ${dia}, abierta desde las ${hora(first.openedAt!)}`;
  }
  const chrono = [...r.noches].reverse().map((n) => diaCorto(n.nombre));
  if (chrono.length <= 3) return `${chrono.length} noches: ${lista(chrono)}`;
  return `${chrono.length} noches, del ${chrono[0]} al ${chrono[chrono.length - 1]}`;
}

/** Lo que dice el botón («Esta noche ▾»). */
export function etiquetaPeriodo(p: Periodo, nights: readonly NocheLista[]): string {
  if (p.clave === 'noche') {
    const n = nights.find((x) => x.id === p.id);
    return n ? `Noche del ${diaCorto(nombreNoche(n.openedAt))}` : 'Otra noche';
  }
  if (p.clave === 'fechas') {
    const short = (day: string) => `${Number(day.slice(8, 10))} ${MESES[Number(day.slice(5, 7)) - 1]!.slice(0, 3)}`;
    return p.desde === p.hasta ? short(p.desde) : `${short(p.desde)} – ${short(p.hasta)}`;
  }
  return NOMBRE_PERIODO[p.clave];
}

// ─── URL ─────────────────────────────────────────────────────────────

export const FECHAS_PARAM = 'fechas';
const EN_URL: readonly ClavePeriodo[] = ['anoche', 'finde', '7noches', 'mes', 'mes-pasado'];
const RANGO = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

/** ?fechas= de Cobros y del mapa. null: no viene; 'roto': no se entiende (se quita). */
export function leerFechas(search: string, now: Date = new Date()): Periodo | 'roto' | null {
  const raw = new URLSearchParams(search).get(FECHAS_PARAM);
  if (raw === null) return null;
  const clave = EN_URL.find((c) => c === raw);
  if (clave) return { clave };
  const m = RANGO.exec(raw);
  if (m && fechasValidas(m[1]!, m[2]!, madridToday(now))) return { clave: 'fechas', desde: m[1]!, hasta: m[2]! };
  return 'roto';
}

/** La query con ese periodo, sin tocar lo demás. Esta noche (y Otra noche, que no va a la URL) la quitan. */
export function escribirFechas(search: string, periodo: Periodo): string {
  const params = new URLSearchParams(search);
  const value =
    periodo.clave === 'fechas' ? `${periodo.desde}_${periodo.hasta}` : EN_URL.includes(periodo.clave as ClavePeriodo) ? periodo.clave : null;
  if (value) params.set(FECHAS_PARAM, value);
  else params.delete(FECHAS_PARAM);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Lee ?fechas= al montar; si no se entiende, la quita de la URL. */
export function periodoDeLaUrl(fallback: Periodo): Periodo {
  if (typeof window === 'undefined') return fallback;
  const read = leerFechas(window.location.search);
  if (read === 'roto') {
    guardarEnUrl(fallback);
    return fallback;
  }
  return read ?? fallback;
}

/** Pone el periodo en la URL (sin dejar rastro en «atrás»). */
export function guardarEnUrl(periodo: Periodo): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const next = escribirFechas(search, periodo);
  if (next !== search) window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
}
