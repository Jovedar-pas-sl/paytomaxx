// La imagen de cada loseta de la carta: de dónde se pide y cuándo se cambia por
// el icono. Funciones puras (se prueban sin pantalla).

/** Lado de la imagen en la loseta (px): el cuadrado de 44 px de Grafito 3. */
export const THUMB_SIZE = 44;

const IMAGE_PATH = /^\/v1\/services\/[0-9a-f-]{36}\/image\/[0-9a-f]{64}$/;

/**
 * La dirección completa de la imagen (el API está en otro origen) o null si el
 * producto no tiene o la ruta no es la de una imagen de la carta: lo único que
 * se pone en el <img> sale de aquí.
 */
export function cartaImageSrc(apiBase: string, imageUrl: string | null | undefined): string | null {
  if (!imageUrl || !IMAGE_PATH.test(imageUrl)) return null;
  return `${apiBase.replace(/\/+$/, '')}${imageUrl}`;
}

/** Imagen mientras carga bien; el icono si no hay o esa dirección falló. */
export function thumbKind(src: string | null, failedSrc: string | null): 'image' | 'icon' {
  return src !== null && src !== failedSrc ? 'image' : 'icon';
}
