// Logo o foto de un producto de la carta: el navegador la recorta en cuadrado y
// la reduce a 128×128 WebP antes de enviarla (o PNG, si el navegador no
// codifica WebP, como Safari; el servidor guarda ambos, 64 KB como mucho). La parte con canvas es solo del navegador; el resto es
// puro y se prueba aparte.

import { CARTA_IMAGE_MAX_BYTES, CARTA_IMAGE_MAX_SIDE, CARTA_IMAGE_TARGET_BYTES } from '@nightpay/contracts';

/** Lo que el navegador sabe abrir. El SVG no entra (puede llevar scripts). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Calidades que se prueban, de más a menos, hasta que cabe en el peso buscado. */
export const WEBP_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.5, 0.35] as const;

/** Lados que se prueban con PNG (no tiene calidad: se baja el tamaño), de mayor a menor. */
export const PNG_SIDES = [128, 112, 96, 80, 64, 48] as const;

export interface SquareCrop {
  sx: number;
  sy: number;
  side: number;
}

/** El cuadrado central de una imagen de `width` × `height`. */
export function squareCrop(width: number, height: number): SquareCrop {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

export function isAcceptedImage(file: Pick<File, 'type'>): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type);
}

export class ImageReduceError extends Error {}

/**
 * Codifica con cada calidad hasta que el resultado cabe en `limit` bytes; si ni
 * con la más baja cabe, el error. `encode` devuelve null si no pudo.
 */
export async function encodeUnderLimit(
  encode: (quality: number) => Promise<Blob | null>,
  limit: number = CARTA_IMAGE_TARGET_BYTES,
  qualities: readonly number[] = WEBP_QUALITIES,
): Promise<Blob> {
  for (const quality of qualities) {
    const blob = await encode(quality);
    if (!blob) throw new ImageReduceError('No se pudo preparar la imagen.');
    if (blob.type !== 'image/webp') throw new ImageReduceError('El navegador no pudo preparar la imagen en WebP.');
    if (blob.size <= limit) return blob;
  }
  throw new ImageReduceError('La imagen sigue pesando demasiado aunque se reduzca. Prueba con otra más sencilla.');
}

/**
 * La imagen para enviar: WebP si el navegador lo codifica (se baja la calidad
 * hasta ≈ 20 KB); si devuelve PNG (Safari), PNG bajando el lado hasta ≈ 20 KB y,
 * si ni así, el más pequeño mientras quepa en los 64 KB del servidor.
 */
export async function encodeCartaImage(
  encodeWebp: (quality: number) => Promise<Blob | null>,
  encodePng: (side: number) => Promise<Blob | null>,
): Promise<Blob> {
  const probe = await encodeWebp(WEBP_QUALITIES[0]);
  if (!probe) throw new ImageReduceError('No se pudo preparar la imagen.');
  if (probe.type === 'image/webp') return encodeUnderLimit(encodeWebp);
  if (probe.type !== 'image/png') throw new ImageReduceError('El navegador no pudo preparar la imagen.');
  let smallest: Blob | null = null;
  for (const side of PNG_SIDES) {
    const blob = await encodePng(side);
    if (!blob || blob.type !== 'image/png') throw new ImageReduceError('No se pudo preparar la imagen.');
    if (blob.size <= CARTA_IMAGE_TARGET_BYTES) return blob;
    smallest = blob;
  }
  if (smallest && smallest.size <= CARTA_IMAGE_MAX_BYTES) return smallest;
  throw new ImageReduceError('La imagen sigue pesando demasiado aunque se reduzca. Prueba con otra más sencilla.');
}

/** Los bytes de un Blob en base64 (sin «data:»), por trozos para no desbordar la pila. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** La imagen reducida, lista para la vista previa y para enviar. */
export interface ReducedImage {
  blob: Blob;
  base64: string;
  previewUrl: string;
}

/**
 * Abre el archivo, recorta el cuadrado central y lo deja en 128×128 (WebP; PNG en Safari)
 * (≈ 20 KB). Solo en el navegador (createImageBitmap + canvas).
 */
export async function reduceCartaImage(file: File): Promise<ReducedImage> {
  if (!isAcceptedImage(file)) throw new ImageReduceError('Usa una imagen PNG, JPG o WebP (no SVG).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageReduceError('No se pudo abrir la imagen. Prueba con otra.');
  }
  try {
    const { sx, sy, side: srcSide } = squareCrop(bitmap.width, bitmap.height);
    const draw = (side: number): HTMLCanvasElement => {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new ImageReduceError('No se pudo preparar la imagen.');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, sx, sy, srcSide, srcSide, 0, 0, side, side);
      return canvas;
    };
    const full = draw(CARTA_IMAGE_MAX_SIDE);
    const toBlob = (canvas: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
    const blob = await encodeCartaImage(
      (q) => toBlob(full, 'image/webp', q),
      (side) => toBlob(side === CARTA_IMAGE_MAX_SIDE ? full : draw(side), 'image/png'),
    );
    return { blob, base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}
