import { z } from 'zod';

/**
 * Colección cerrada de iconos de la carta (20261111100000). Los dibujos están
 * en @nightpay/ui (CartaIcon); aquí, solo los códigos, sus nombres y el icono
 * de cada sección. La migración lleva la misma lista en su CHECK.
 */
export const CARTA_ICONS = [
  { code: 'copa', label: 'Copa' },
  { code: 'gin_tonic', label: 'Gin tonic' },
  { code: 'cerveza', label: 'Cerveza' },
  { code: 'cava', label: 'Cava o champán' },
  { code: 'vino', label: 'Vino' },
  { code: 'chupito', label: 'Chupito' },
  { code: 'coctel', label: 'Cóctel' },
  { code: 'refresco', label: 'Refresco' },
  { code: 'agua', label: 'Agua' },
  { code: 'zumo', label: 'Zumo' },
  { code: 'botella', label: 'Botella' },
  { code: 'cafe', label: 'Café' },
  { code: 'entrada', label: 'Entrada' },
  { code: 'entrada_copa', label: 'Entrada con copa' },
  { code: 'habitacion', label: 'Habitación' },
  { code: 'reservado', label: 'Reservado' },
  { code: 'nachos', label: 'Nachos' },
  { code: 'tapa', label: 'Tapa' },
  { code: 'tabla', label: 'Tabla' },
  { code: 'hamburguesa', label: 'Hamburguesa' },
  { code: 'postre', label: 'Postre' },
  { code: 'cachimba', label: 'Cachimba' },
  { code: 'ticket', label: 'Ticket' },
  { code: 'estrella', label: 'Estrella' },
  { code: 'plato', label: 'Plato' },
] as const;

export type CartaIconCode = (typeof CARTA_ICONS)[number]['code'];

export const CARTA_ICON_CODES = CARTA_ICONS.map((i) => i.code) as readonly CartaIconCode[];

export const CartaIconSchema = z.enum(CARTA_ICONS.map((i) => i.code) as [CartaIconCode, ...CartaIconCode[]]);

/** El icono de cada sección cuando el producto no elige uno. */
const SECTION_ICON: Readonly<Record<string, CartaIconCode>> = {
  VENUE_BAR: 'copa',
  VENUE_FOOD: 'plato',
  VENUE_ENTRY: 'entrada',
  VENUE_ROOM: 'habitacion',
  CHICA_SERVICE: 'estrella',
};

export function isCartaIcon(value: unknown): value is CartaIconCode {
  return typeof value === 'string' && (CARTA_ICON_CODES as readonly string[]).includes(value);
}

/** El icono por defecto de una sección (una desconocida, como «Otros»: la estrella). */
export function defaultCartaIcon(category: string): CartaIconCode {
  return SECTION_ICON[category] ?? 'estrella';
}

/** El icono que se dibuja: el del producto si es de la colección; si no, el de su sección. */
export function cartaIconOf(item: { icon?: string | null; category: string }): CartaIconCode {
  return isCartaIcon(item.icon) ? item.icon : defaultCartaIcon(item.category);
}

/** Lo que pide la subida de la imagen y el servidor guarda (WebP cuadrado, 128 px como mucho). */
export const CARTA_IMAGE_MAX_BYTES = 64 * 1024;
export const CARTA_IMAGE_MAX_SIDE = 128;
export const CARTA_IMAGE_MIN_SIDE = 16;
/** Lo que apunta el panel al reducirla. */
export const CARTA_IMAGE_TARGET_BYTES = 20 * 1024;

/** `PUT /v1/services/:id/image`: la imagen ya reducida (WebP) en base64. */
export const UploadServiceImageSchema = z.object({
  /** Base64 de los bytes WebP (sin «data:»). El servidor comprueba los bytes, no esto. */
  data: z
    .string()
    .min(16, 'Falta la imagen')
    .max(Math.ceil((CARTA_IMAGE_MAX_BYTES * 4) / 3) + 8, 'La imagen pesa demasiado (64 KB como mucho)')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'La imagen no es válida'),
});
export type UploadServiceImageDto = z.infer<typeof UploadServiceImageSchema>;

/** La URL de la imagen de un producto, versionada por su huella: nunca cambia de contenido. */
export function serviceImagePath(itemId: string, contentHash: string): string {
  return `/v1/services/${itemId}/image/${contentHash}`;
}
