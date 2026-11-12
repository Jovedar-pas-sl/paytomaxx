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
  email: string;
  phone: string | null;
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

// ── Contacto y seguridad ────────────────────────────────────────────

/** Quita lo que la gente escribe de adorno en un teléfono: espacios, puntos, guiones y paréntesis. */
function compactPhone(v: string): string {
  return v.replace(/[\s.\-()]/g, '');
}

/**
 * Teléfono español (9 cifras, empieza por 6, 7, 8 o 9; con o sin +34 / 0034) o
 * internacional (+ y de 8 a 15 cifras). Se guarda en forma compacta con «+».
 * Es el mismo campo `users.phone` del alta de la compañera.
 */
export function normalizePhone(raw: string): string | null {
  const compact = compactPhone(raw.trim());
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (/^[6-9]\d{8}$/.test(withPlus)) return `+34${withPlus}`;
  if (/^\+34[6-9]\d{8}$/.test(withPlus)) return withPlus;
  if (/^\+(?!34)[1-9]\d{7,14}$/.test(withPlus)) return withPlus;
  return null;
}

/** `PATCH /v1/me/contact`: el teléfono (vacío = quitarlo). */
export const UpdatePhoneSchema = z.object({
  phone: z
    .string({ error: 'Escribe tu teléfono' })
    .max(40, 'El teléfono es demasiado largo')
    .transform((v, ctx) => {
      if (v.trim() === '') return null;
      const n = normalizePhone(v);
      if (!n) {
        ctx.addIssue({ code: 'custom', message: 'Escribe un teléfono español (9 cifras) o internacional con +, por ejemplo +34 600 123 456' });
        return z.NEVER;
      }
      return n;
    }),
});
export type UpdatePhoneDto = z.infer<typeof UpdatePhoneSchema>;

const CurrentPasswordField = z.string({ error: 'Escribe tu contraseña actual' }).min(1, 'Escribe tu contraseña actual').max(200);
/** La misma regla que el resto del sistema (login, restablecer): de 8 a 200 caracteres. */
export const NEW_PASSWORD_MIN = 8;
export const NEW_PASSWORD_MAX = 200;

/** `PATCH /v1/me/email`: el correo con el que entra. Pide la contraseña actual. */
export const UpdateEmailSchema = z.object({
  email: z
    .string({ error: 'Escribe tu correo' })
    .trim()
    .toLowerCase()
    .max(254, 'El correo es demasiado largo')
    .pipe(z.string().email('Ese correo no es válido')),
  currentPassword: CurrentPasswordField,
});
export type UpdateEmailDto = z.infer<typeof UpdateEmailSchema>;

/** `POST /v1/me/password`: la actual y la nueva dos veces. */
export const ChangePasswordSchema = z
  .object({
    currentPassword: CurrentPasswordField,
    newPassword: z
      .string({ error: 'Escribe la contraseña nueva' })
      .min(NEW_PASSWORD_MIN, `La contraseña nueva tiene que tener al menos ${NEW_PASSWORD_MIN} caracteres`)
      .max(NEW_PASSWORD_MAX, 'La contraseña nueva es demasiado larga'),
    newPasswordRepeat: z.string({ error: 'Repite la contraseña nueva' }),
  })
  .refine((v) => v.newPassword === v.newPasswordRepeat, { path: ['newPasswordRepeat'], message: 'Las dos contraseñas nuevas no coinciden' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: 'La contraseña nueva tiene que ser distinta de la actual' });
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;
