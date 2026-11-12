import { createHash } from 'node:crypto';
import { PROFILE_PHOTO_MAX_BYTES, PROFILE_PHOTO_MAX_SIDE, PROFILE_PHOTO_MIN_SIDE } from '@nightpay/contracts';
import { sniffImage, webpSize } from '../carta/carta-image';

/** Los tipos de la foto de perfil (la lista de la migración). */
export type ProfilePhotoType = 'image/webp' | 'image/jpeg';

export interface CheckedPhoto {
  data: Buffer;
  contentType: ProfilePhotoType;
  contentHash: string;
  width: number;
  height: number;
}

export type PhotoCheck = { ok: true; image: CheckedPhoto } | { ok: false; message: string };

// Marcadores SOF (SOF0..SOF15 salvo DHT 0xC4, JPG 0xC8 y DAC 0xCC): llevan alto y ancho.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** El ancho y el alto de un JPEG (marcador SOF) o null si no se encuentran antes de los datos. */
export function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // relleno
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // marcadores sin longitud
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // empiezan los datos sin haber visto el SOF
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    if (isSof(marker)) {
      if (i + 9 > b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * Comprueba la foto de perfil que llega: solo WebP o JPEG (por los bytes),
 * menos de 150 KB, cuadrada y de 32 a 256 px. Un SVG, un PNG, un GIF o un WebP
 * animado no se guardan. Se guarda tal cual, sin reencodificar.
 */
export function checkProfilePhoto(data: Buffer): PhotoCheck {
  if (data.length === 0) return { ok: false, message: 'La foto está vacía.' };
  if (data.length > PROFILE_PHOTO_MAX_BYTES) {
    return { ok: false, message: `La foto pesa ${Math.ceil(data.length / 1024)} KB; el máximo es ${PROFILE_PHOTO_MAX_BYTES / 1024} KB.` };
  }
  const kind = sniffImage(data);
  if (kind !== 'webp' && kind !== 'jpeg') return { ok: false, message: 'Solo se admiten fotos WebP o JPEG.' };
  const size = kind === 'webp' ? webpSize(data) : jpegSize(data);
  if (!size) return { ok: false, message: `La foto ${kind === 'webp' ? 'WebP' : 'JPEG'} no es válida (o es animada).` };
  const { width, height } = size;
  if (width !== height) return { ok: false, message: 'La foto tiene que ser cuadrada.' };
  if (width < PROFILE_PHOTO_MIN_SIDE || width > PROFILE_PHOTO_MAX_SIDE) {
    return { ok: false, message: `La foto tiene que medir entre ${PROFILE_PHOTO_MIN_SIDE} y ${PROFILE_PHOTO_MAX_SIDE} píxeles de lado.` };
  }
  const contentType: ProfilePhotoType = kind === 'webp' ? 'image/webp' : 'image/jpeg';
  return { ok: true, image: { data, contentType, contentHash: createHash('sha256').update(data).digest('hex'), width, height } };
}
