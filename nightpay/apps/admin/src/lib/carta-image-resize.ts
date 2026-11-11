// Logo o foto de un producto de la carta: el navegador la recorta en cuadrado y
// la reduce a 128×128 WebP antes de enviarla (el servidor solo guarda WebP de
// 64 KB como mucho). La parte con canvas es solo del navegador; el resto es
// puro y se prueba aparte.

import { CARTA_IMAGE_MAX_SIDE, CARTA_IMAGE_TARGET_BYTES } from '@nightpay/contracts';

/** Lo que el navegador sabe abrir. El SVG no entra (puede llevar scripts). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Calidades que se prueban, de más a menos, hasta que cabe en el peso buscado. */
export const WEBP_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.5, 0.35] as const;

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
    if (blob.type !== 'image/webp') {
      throw new ImageReduceError('Este navegador no sabe guardar imágenes WebP. Usa Chrome, Edge o Firefox para subir el logo.');
    }
    if (blob.size <= limit) return blob;
  }
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
 * Abre el archivo, recorta el cuadrado central y lo deja en 128×128 WebP
 * (≈ 20 KB). Solo en el navegador (createImageBitmap + canvas).
 */
export async function reduceToWebp(file: File): Promise<ReducedImage> {
  if (!isAcceptedImage(file)) throw new ImageReduceError('Usa una imagen PNG, JPG o WebP (no SVG).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageReduceError('No se pudo abrir la imagen. Prueba con otra.');
  }
  try {
    const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = CARTA_IMAGE_MAX_SIDE;
    canvas.height = CARTA_IMAGE_MAX_SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageReduceError('No se pudo preparar la imagen.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, CARTA_IMAGE_MAX_SIDE, CARTA_IMAGE_MAX_SIDE);
    const blob = await encodeUnderLimit((q) => new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', q)));
    return { blob, base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}
