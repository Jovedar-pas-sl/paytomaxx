import { z } from 'zod';

/**
 * «Mi perfil» del personal (compañeras, camareros, recepción, encargados y
 * dueño): su nombre visible y su foto. Nada de datos legales ni de cobro.
 */
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;

/** ¿Lleva algún carácter de control (C0, DEL, C1 o separadores de línea)? Por código, sin escapes en la expresión. */
const hasControlChars = (v: string): boolean =>
  Array.from(v).some((ch) => {
    const c = ch.codePointAt(0)!;
    return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
  });

/** `PATCH /v1/me/profile`: el nombre que ven los demás. Sin espacios a los lados, de 2 a 40 caracteres. */
export const UpdateProfileSchema = z.object({
  displayName: z
    .string({ error: 'Escribe tu nombre' })
    .refine((v) => v === v.trim(), 'El nombre no puede empezar ni acabar con espacios')
    .refine((v) => v.length >= DISPLAY_NAME_MIN, `El nombre tiene que tener al menos ${DISPLAY_NAME_MIN} caracteres`)
    .refine((v) => v.length <= DISPLAY_NAME_MAX, `El nombre puede tener ${DISPLAY_NAME_MAX} caracteres como mucho`)
    .refine((v) => !hasControlChars(v), 'El nombre tiene caracteres que no se admiten'),
});
export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;

/** La foto ya recortada y reducida por el móvil: 256×256 como mucho, WebP o JPEG, menos de 150 KB. */
export const PROFILE_PHOTO_MAX_BYTES = 150 * 1024;
export const PROFILE_PHOTO_MAX_SIDE = 256;
export const PROFILE_PHOTO_MIN_SIDE = 32;
export const PROFILE_PHOTO_TARGET_SIDE = 256;

/** `PUT /v1/me/photo`: la foto en base64 (sin «data:»). El servidor comprueba los bytes, no esto. */
export const UploadProfilePhotoSchema = z.object({
  data: z
    .string()
    .min(16, 'Falta la foto')
    .max(Math.ceil((PROFILE_PHOTO_MAX_BYTES * 4) / 3) + 8, 'La foto pesa demasiado (150 KB como mucho)')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'La foto no es válida'),
});
export type UploadProfilePhotoDto = z.infer<typeof UploadProfilePhotoSchema>;

/** Lo que devuelve `GET /v1/me/profile` (y los cambios). */
export interface MyProfile {
  userId: string;
  displayName: string | null;
  role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
  venueName: string;
  hasPhoto: boolean;
  /** Huella de la foto (SHA-256), o null sin foto. */
  photoHash: string | null;
}

/** La dirección de la foto de una persona, versionada por su huella (se pide con la sesión puesta). */
export function staffPhotoPath(userId: string, contentHash: string): string {
  return `/v1/staff/${userId}/photo/${contentHash}`;
}

/** Las iniciales para quien no tiene foto: hasta dos letras del nombre (o «?»). */
export function profileInitials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0]!)[0] ?? '?';
  const second = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? '') : '';
  return (first + second).toUpperCase();
}
