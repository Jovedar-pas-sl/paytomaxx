import { z } from 'zod';

/**
 * El documento de la compañera (cobro por el encargado, fase 3,
 * 20261127040000_documento_companera): el tipo (DNI, NIE o pasaporte) y el
 * número, cifrados como su cuenta de cobro (ENCRYPTION_KEK). El encargado lo
 * ve tapado (los últimos caracteres); entero, solo el dueño con su 2FA, y queda
 * en el registro. Se borra al darla de baja. Aparte de los «4 últimos del
 * pasaporte» y el país de siempre (en claro), que no cambian.
 */

export const ID_DOCUMENT_TYPES = ['DNI', 'NIE', 'PASAPORTE'] as const;
export const IdDocumentTypeSchema = z.enum(ID_DOCUMENT_TYPES);
export type IdDocumentType = z.infer<typeof IdDocumentTypeSchema>;

export const ID_DOCUMENT_TYPE_LABEL: Readonly<Record<IdDocumentType, string>> = {
  DNI: 'DNI',
  NIE: 'NIE',
  PASAPORTE: 'Pasaporte',
};

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** «12.345.678-z » → «12345678Z»: sin espacios, puntos ni guiones, en mayúsculas. */
export function normalizeIdDocumentNumber(raw: string): string {
  return raw.replace(/[\s.\-/]/g, '').toUpperCase();
}

/** Por qué no vale ese número para ese tipo (null si vale). Ya normalizado. */
export function idDocumentProblem(type: IdDocumentType, number: string): string | null {
  if (type === 'DNI') {
    const m = /^(\d{8})([A-Z])$/.exec(number);
    if (!m) return 'El DNI son 8 cifras y una letra.';
    return DNI_LETTERS[Number(m[1]) % 23] === m[2] ? null : 'La letra del DNI no cuadra con las cifras: revísalo.';
  }
  if (type === 'NIE') {
    const m = /^([XYZ])(\d{7})([A-Z])$/.exec(number);
    if (!m) return 'El NIE es X, Y o Z, 7 cifras y una letra.';
    const digits = `${'XYZ'.indexOf(m[1]!)}${m[2]}`;
    return DNI_LETTERS[Number(digits) % 23] === m[3] ? null : 'La letra del NIE no cuadra con las cifras: revísalo.';
  }
  return /^[A-Z0-9]{5,20}$/.test(number) ? null : 'El pasaporte son de 5 a 20 letras o cifras.';
}

/** Lo que se guarda (del panel): o los dos, o null para quitarlo. */
export const IdDocumentInputSchema = z
  .object({
    type: IdDocumentTypeSchema,
    number: z.string().trim().min(1).max(40).transform(normalizeIdDocumentNumber),
  })
  .strict()
  .superRefine((d, ctx) => {
    const problem = idDocumentProblem(d.type, d.number);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ['number'] });
  });
export type IdDocumentInput = z.infer<typeof IdDocumentInputSchema>;

/** Tapado: «•••• 678Z» (los 4 últimos; con menos de 8, los 3 últimos). */
export function maskIdDocumentNumber(number: string): string {
  const keep = number.length >= 8 ? 4 : 3;
  return `•••• ${number.slice(-keep)}`;
}

/** POST /v1/admin/operators/:id/id-document/reveal (el dueño, con su 2FA). */
export const RevealIdDocumentSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
export type RevealIdDocumentDto = z.infer<typeof RevealIdDocumentSchema>;

export interface IdDocumentFull {
  userId: string;
  type: IdDocumentType;
  number: string;
}
