// OxioParty: «Modo día», para cobrar al sol (las Fallas, las fiestas de
// agosto). Una preferencia de ESTE móvil (localStorage, nunca al servidor) que
// pone data-theme="day" en <html>; las variables --np-* de día están en
// app/party-day.css y solo valen en la app del personal. Todo tolera un
// almacenamiento bloqueado (modo privado): entonces se queda la noche.

import { applyThemeChoice, browserStore, readThemeChoice, type KeyValueStore } from '@nightpay/ui/device-settings';

export const DAY_MODE_KEY = 'np-party-day';
export const DAY_THEME = 'day';

/** El color de la barra del navegador (meta theme-color) en cada modo. */
export const DAY_CHROME = '#F3F1EC';
export const NIGHT_CHROME = '#091518';

/** ¿Este móvil tiene puesto el modo día? (sin almacenamiento, no). */
export function readDayMode(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): boolean {
  try {
    return store?.getItem(DAY_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDayMode(store: Pick<KeyValueStore, 'setItem' | 'removeItem'> | null, on: boolean): void {
  try {
    if (!store) return;
    if (on) store.setItem(DAY_MODE_KEY, '1');
    else store.removeItem(DAY_MODE_KEY);
  } catch {
    /* sin almacenamiento: vale para esta visita */
  }
}

/**
 * Pone (o quita) el modo día en la página y lo recuerda. Al quitarlo vuelve
 * el tema que este móvil tenía elegido en «Mi perfil» (de partida, oscuro).
 */
export function applyDayMode(on: boolean): void {
  writeDayMode(browserStore(), on);
  if (typeof document === 'undefined') return;
  if (on) document.documentElement.setAttribute('data-theme', DAY_THEME);
  else applyThemeChoice(readThemeChoice(browserStore(), 'dark'));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', on ? DAY_CHROME : NIGHT_CHROME);
}

/**
 * Para el <head> del layout, antes de pintar y después del tema (sin
 * parpadeo): si este móvil tiene el modo día, lo pone ya. Solo en OxioParty.
 */
export const DAY_INIT_SCRIPT = `try{if(localStorage.getItem('${DAY_MODE_KEY}')==='1')document.documentElement.setAttribute('data-theme','${DAY_THEME}');}catch(e){}`;

/**
 * Los colores de día de la maqueta aprobada (Main.dc.html y Taquilla.dc.html),
 * los mismos que app/party-day.css: fondo, superficie, filete, los tres
 * textos y el botón principal en tinta con la lima encima.
 */
export const DAY_PALETTE = {
  bg: '#F3F1EC',
  surface: '#FFFFFF',
  line: '#E0DBD1',
  lineStrong: '#8A9096',
  t1: '#14181B',
  t2: '#3F474E',
  t3: '#5C656D',
  ok: '#1F7A4D',
  okBg: '#E2F1E8',
  warn: '#8A5A00',
  warnBg: '#FBEFD4',
  danger: '#B8232A',
  action: '#14181B',
  onAction: '#C7D301',
  chosenInk: '#FFFFFF',
} as const;

function channel(hex: string, at: number): number {
  const v = parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa (WCAG 2) de un color #RRGGBB. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return 0.2126 * channel(full, 0) + 0.7152 * channel(full, 2) + 0.0722 * channel(full, 4);
}

/** Contraste WCAG 2 entre dos colores (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
