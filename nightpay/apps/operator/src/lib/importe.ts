// «Otro importe» (maqueta 1.3): se teclea en euros, como se dice («35», «12,50»),
// con coma para los céntimos. Lo tecleado es un texto («35,5»); el importe,
// en céntimos. Funciones puras.

export type ImporteKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ',' | 'back';

/** El teclado: 1-9, coma, 0 y borrar (siempre en este orden). */
export const IMPORTE_KEYS: readonly ImporteKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'];

// ─── El teclado según el alto de la pantalla (Grafito 3) ───────────────
// Lo mismo que cobrar.module.css (.key, .amountShow, .head, .foot): si cambia
// uno, cambia el otro (lo comprueba ui-grafito3.test.ts).

export const KEY_MIN_PX = 48;
export const KEY_MAX_PX = 72;
/** 8,5 svh. */
export const KEY_VH_RATIO = 0.085;
/** Desde este alto, el importe va a 64 y las teclas a 28. */
export const TALL_SCREEN_PX = 760;
/** Hasta este alto (un móvil bajo, 360 × 640), las teclas bajan a 44 px: @media (max-height: 700px). */
export const SHORT_SCREEN_PX = 700;
export const KEY_SHORT_PX = 44;

/** Alto de una tecla: 44 px hasta 700 de alto; si no, clamp(48px, 8.5svh, 72px). */
export function keyHeightPx(viewportHeightPx: number): number {
  if (viewportHeightPx <= SHORT_SCREEN_PX) return KEY_SHORT_PX;
  return Math.min(KEY_MAX_PX, Math.max(KEY_MIN_PX, viewportHeightPx * KEY_VH_RATIO));
}

/** Alto de la barra de pestañas: clamp(3.5rem, 8svh, 4.25rem). */
export function tabBarPx(viewportHeightPx: number): number {
  return Math.min(68, Math.max(56, viewportHeightPx * 0.08));
}

/**
 * Lo que mide «Otro importe» de arriba abajo, con la barra de pestañas: la
 * cabecera (65, medida en la captura), el relleno (24) y los tres huecos (36),
 * el importe (48 o 72), «¿De qué es?» (18), las secciones (48 por fila y 8
 * entre filas), las cuatro filas de teclas (huecos de 8) y el pie con «Añadir» (85).
 */
export function otroImporteHeightPx(viewportHeightPx: number, sectionRows: 1 | 2): number {
  const amount = viewportHeightPx >= TALL_SCREEN_PX ? 72 : 48;
  const sections = sectionRows * 48 + (sectionRows - 1) * 8;
  const keys = 4 * keyHeightPx(viewportHeightPx) + 3 * 8;
  return 65 + 24 + 36 + amount + 18 + sections + keys + 85 + tabBarPx(viewportHeightPx);
}

/** Como mucho, lo de un cobro tecleado (10.000 €). */
export const MAX_IMPORTE_CENTS = 10_000_00;

/** Lo tecleado tras pulsar una tecla (sin pasar del tope, dos decimales, sin ceros delante). */
export function pressImporte(typed: string, key: ImporteKey, maxCents: number = MAX_IMPORTE_CENTS): string {
  if (key === 'back') return typed.slice(0, -1);
  if (key === ',') {
    if (typed.includes(',')) return typed;
    return typed === '' ? '0,' : `${typed},`;
  }
  const [, decimals] = typed.split(',');
  if (decimals !== undefined && decimals.length >= 2) return typed;
  const next = typed === '0' ? key : `${typed}${key}`;
  return importeCents(next) > maxCents ? typed : next;
}

/** «35» → 3500; «12,5» → 1250; «0,» → 0. */
export function importeCents(typed: string): number {
  if (!typed) return 0;
  const [whole = '', decimals = ''] = typed.split(',');
  const euros = Number.parseInt(whole || '0', 10);
  const cents = Number.parseInt((decimals + '00').slice(0, 2), 10);
  return (Number.isFinite(euros) ? euros : 0) * 100 + (Number.isFinite(cents) ? cents : 0);
}

/** Lo que se ve: «35», «12,5», «0» si no hay nada. */
export function importeShown(typed: string): string {
  return typed === '' ? '0' : typed;
}
