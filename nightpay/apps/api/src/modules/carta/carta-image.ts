import { createHash } from 'node:crypto';
import { CARTA_IMAGE_MAX_BYTES, CARTA_IMAGE_MAX_SIDE, CARTA_IMAGE_MIN_SIDE } from '@nightpay/contracts';

/** Los tipos que se guardan (la lista de la migración). */
export type CartaImageType = 'image/webp' | 'image/png';

/** Una imagen que se puede guardar: WebP o PNG ya comprobado. */
export interface CheckedImage {
  data: Buffer;
  contentType: CartaImageType;
  contentHash: string;
  width: number;
  height: number;
}

export type ImageCheck = { ok: true; image: CheckedImage } | { ok: false; message: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Sniffed = 'webp' | 'png' | 'jpeg' | 'other';

/** Qué es por sus primeros bytes (nunca por el nombre ni por lo que diga quien la manda). */
export function sniffImage(bytes: Uint8Array): Sniffed {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return 'other';
}

/** El ancho y el alto de un WebP (VP8, VP8L o VP8X) o null si la cabecera no cuadra. Sin animaciones. */
export function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  // El tamaño del RIFF tiene que cuadrar con lo recibido (nada pegado detrás).
  if (b.readUInt32LE(4) + 8 !== b.length) return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    // Bit 1 (0x02) de las banderas: animación. No se guardan.
    if ((b[20]! & 0x02) !== 0) return null;
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** El ancho y el alto de un PNG (chunk IHDR, que va siempre primero) o null si no cuadra. */
export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Comprueba lo que llega al subir el logo o la foto: solo WebP o PNG (por los
 * bytes; el PNG es para los navegadores que no codifican WebP, como Safari),
 * como mucho 64 KB, cuadrada y de 16 a 128 px. Un SVG, un JPEG o cualquier otra
 * cosa no se guarda. Se guarda tal cual, sin reencodificar.
 */
export function checkCartaImage(data: Buffer): ImageCheck {
  if (data.length === 0) return { ok: false, message: 'La imagen está vacía.' };
  if (data.length > CARTA_IMAGE_MAX_BYTES) {
    return { ok: false, message: `La imagen pesa ${Math.ceil(data.length / 1024)} KB; el máximo es ${CARTA_IMAGE_MAX_BYTES / 1024} KB.` };
  }
  const kind = sniffImage(data);
  if (kind !== 'webp' && kind !== 'png') return { ok: false, message: 'Solo se admiten imágenes WebP o PNG (no SVG, JPEG ni otros formatos).' };
  const size = kind === 'webp' ? webpSize(data) : pngSize(data);
  if (!size) return { ok: false, message: `La imagen ${kind === 'webp' ? 'WebP' : 'PNG'} no es válida (o es animada).` };
  const { width, height } = size;
  if (width !== height) return { ok: false, message: 'La imagen tiene que ser cuadrada.' };
  if (width < CARTA_IMAGE_MIN_SIDE || width > CARTA_IMAGE_MAX_SIDE) {
    return { ok: false, message: `La imagen tiene que medir entre ${CARTA_IMAGE_MIN_SIDE} y ${CARTA_IMAGE_MAX_SIDE} píxeles de lado.` };
  }
  const contentType: CartaImageType = kind === 'webp' ? 'image/webp' : 'image/png';
  return { ok: true, image: { data, contentType, contentHash: createHash('sha256').update(data).digest('hex'), width, height } };
}

/** El base64 que llega, a bytes (el esquema ya limita largo y alfabeto). */
export function decodeImageBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}
