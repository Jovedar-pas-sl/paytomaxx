// La foto de perfil, preparada en el móvil antes de subirla: recorte cuadrado al
// centro, reducida a 256×256 y en WebP (o JPEG si el navegador no codifica
// WebP), por debajo de 150 KB. La parte de cuentas es pura y se prueba sin
// navegador; solo `prepareProfilePhoto` toca el canvas.

import { PROFILE_PHOTO_MAX_BYTES, PROFILE_PHOTO_MAX_SIDE, PROFILE_PHOTO_MIN_SIDE } from '@nightpay/contracts';

export const PHOTO_OUT_SIDE = PROFILE_PHOTO_MAX_SIDE;
export const PHOTO_MAX_BYTES = PROFILE_PHOTO_MAX_BYTES;
/** De mejor a peor calidad: se coge la primera que cabe. */
export const PHOTO_QUALITIES: readonly number[] = [0.85, 0.75, 0.65, 0.5, 0.4];

export interface PhotoPlan {
  /** Esquina del cuadrado que se recorta de la foto original. */
  sx: number;
  sy: number;
  /** Lado de ese cuadrado en la original. */
  side: number;
  /** Lado de la foto de salida: 256, o el de la original si es más pequeña (no se agranda). */
  out: number;
}

/** El recorte cuadrado al centro y el lado de salida; null si la foto no sirve (sin medidas o con un lado menor de 32 px). */
export function photoPlan(width: number, height: number): PhotoPlan | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const side = Math.floor(Math.min(width, height));
  if (side < PROFILE_PHOTO_MIN_SIDE) return null;
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side, out: Math.min(PHOTO_OUT_SIDE, side) };
}

export type PhotoMime = 'image/webp' | 'image/jpeg';
/** Codifica el cuadrado ya dibujado (canvas.toBlob); null si el navegador no puede. */
export type PhotoEncoder = (type: PhotoMime, quality: number) => Promise<Blob | null>;

export interface EncodedPhoto {
  blob: Blob;
  type: PhotoMime;
  quality: number;
}

/**
 * La primera codificación que cabe: WebP de mejor a peor calidad y, si el
 * navegador no sabe WebP (Safari devuelve PNG sin avisar), JPEG. null si nada cabe.
 */
export async function encodeProfilePhoto(encode: PhotoEncoder): Promise<EncodedPhoto | null> {
  for (const type of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of PHOTO_QUALITIES) {
      const blob = await encode(type, quality);
      if (!blob) break;
      if (blob.type !== type) break; // pidió WebP y salió PNG: este formato no sirve aquí
      if (blob.size <= PHOTO_MAX_BYTES) return { blob, type, quality };
    }
  }
  return null;
}

export class PhotoPrepareError extends Error {}

/** Un archivo de imagen del móvil (galería o cámara) → los bytes listos para subir, en base64. */
export async function prepareProfilePhoto(file: Blob): Promise<{ base64: string; width: number; height: number; type: PhotoMime; bytes: number }> {
  if (typeof createImageBitmap !== 'function') throw new PhotoPrepareError('Este móvil no puede preparar la foto. Prueba con otro navegador.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoPrepareError('No se ha podido abrir esa imagen. Prueba con otra foto.');
  }
  try {
    const plan = photoPlan(bitmap.width, bitmap.height);
    if (!plan) throw new PhotoPrepareError('La foto es demasiado pequeña. Elige otra.');
    const canvas = document.createElement('canvas');
    canvas.width = plan.out;
    canvas.height = plan.out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoPrepareError('Este móvil no puede preparar la foto. Prueba con otro navegador.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, plan.sx, plan.sy, plan.side, plan.side, 0, 0, plan.out, plan.out);
    const encoded = await encodeProfilePhoto((type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)));
    if (!encoded) throw new PhotoPrepareError('La foto pesa demasiado aun reducida. Elige otra.');
    return { base64: await blobToBase64(encoded.blob), width: plan.out, height: plan.out, type: encoded.type, bytes: encoded.blob.size };
  } finally {
    bitmap.close();
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
