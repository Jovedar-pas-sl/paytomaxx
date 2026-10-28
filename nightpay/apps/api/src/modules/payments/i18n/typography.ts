/**
 * Tipografía francesa: espacio fino irrompible antes de « ; ! ? », espacio
 * irrompible antes de « : » y dentro de las comillas « ». Los textos se
 * escriben con espacios normales (fr.ts) y aquí se arreglan: así ningún
 * signo se queda solo al principio de una línea en un móvil estrecho.
 * Las funciones de texto (con el importe dentro) se envuelven igual.
 */
const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);

export function frenchSpacing(text: string): string {
  return text
    .replace(/ ([;!?])/g, `${NNBSP}$1`)
    .replace(/ :/g, `${NBSP}:`)
    .replace(/« /g, `«${NBSP}`)
    .replace(/ »/g, `${NBSP}»`);
}

/** El mismo objeto con todos sus textos (y lo que devuelven sus funciones) arreglados. */
export function withFrenchSpacing<T>(value: T): T {
  if (typeof value === 'string') return frenchSpacing(value) as T;
  if (typeof value === 'function') {
    const fn = value as unknown as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => withFrenchSpacing(fn(...args))) as T;
  }
  if (Array.isArray(value)) return value.map((v) => withFrenchSpacing(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withFrenchSpacing(v)])) as T;
  }
  return value;
}
