import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';

/**
 * Datáfono PAX con la app NightPay (Paytef Device API). Reglas puras: el
 * resultado que manda el datáfono, la referencia de cada cobro, la marca de
 * la tarjeta y los códigos de vinculación.
 *
 * Formato según https://docs.paytef.es/device_api/ (resultado de
 * /transaction/poll). Lo que la doc no fija (importes en céntimos, longitud de
 * la referencia) está pendiente de confirmar con Paytef: va en constantes.
 */

/** Longitud de la referencia que se manda a Paytef (transactionReference). */
export const POS_REFERENCE_LENGTH = 20;

/** "NP" + 18 caracteres del id del cobro: identifica el cobro en el datáfono. */
export function posReference(paymentId: string): string {
  return `NP${paymentId.replace(/-/g, '').toUpperCase()}`.slice(0, POS_REFERENCE_LENGTH);
}

/** Resultado de una venta tal como lo devuelve Paytef (lo que nos importa). */
export const PaytefSaleResultSchema = z
  .object({
    approved: z.boolean(),
    resultCode: z.union([z.string(), z.number()]).optional(),
    resultText: z.string().max(200).optional(),
    authorisationCode: z.string().max(20).optional(),
    paytefOperationNumber: z.union([z.string().max(64), z.number().int().nonnegative()]).optional(),
    transactionReference: z.string().max(64).optional(),
    requestedAmount: z.number().int().nonnegative().optional(),
    tipAmount: z.number().int().nonnegative().optional(),
    pinpadSerialNumber: z.string().max(64).optional(),
    timestamp: z.string().max(64).optional(),
    cardInformation: z
      .object({
        hiddenCardNumber: z.string().max(40).optional(),
        cardTypeCode: z.string().max(10).optional(),
        isContactless: z.boolean().optional(),
        isMobile: z.boolean().optional(),
        dataEntryLetter: z.string().max(20).optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type PaytefSaleResult = z.infer<typeof PaytefSaleResultSchema>;

/** Número de operación de Paytef como texto (la doc lo da a veces como número). */
export function operationNumberOf(r: PaytefSaleResult): string | null {
  const op = r.paytefOperationNumber;
  if (op === undefined || op === null) return null;
  const s = String(op).trim();
  return s === '' ? null : s;
}

/** Últimos 4 dígitos de "************1111". */
export function last4Of(r: PaytefSaleResult): string | null {
  const digits = (r.cardInformation?.hiddenCardNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Marca de Paytef (VI, MC…) → código Ds_Card_Brand de Redsys, para que los
 * cobros por datáfono salgan igual que los online en panel e informes.
 */
const PAYTEF_BRAND_TO_REDSYS: Record<string, string> = {
  VI: '1',
  MC: '2',
  MA: '2',
  AX: '8',
  JC: '9',
  DC: '6',
  DI: '6',
  UP: '22',
  CU: '22',
};

export function cardBrandOf(r: PaytefSaleResult): string | null {
  const code = r.cardInformation?.cardTypeCode?.toUpperCase();
  return code ? (PAYTEF_BRAND_TO_REDSYS[code] ?? null) : null;
}

/** Cómo se leyó la tarjeta: móvil (Apple/Google Pay), sin contacto, chip… */
export function payMethodCodeOf(r: PaytefSaleResult): string {
  const c = r.cardInformation;
  if (c?.isMobile) return 'PAX_MOBILE';
  if (c?.isContactless) return 'PAX_CONTACTLESS';
  const entry = c?.dataEntryLetter?.toLowerCase() ?? '';
  if (entry.includes('chip') || entry === 'c') return 'PAX_CHIP';
  if (entry.includes('manual') || entry === 'm') return 'PAX_MANUAL';
  if (entry.includes('stripe') || entry === 'b') return 'PAX_STRIPE';
  return 'PAX';
}

// ─── Vinculación del datáfono ───────────────────────────────────────────

/** Sin letras que se confunden (0/O, 1/I/L). */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/** Código que el dueño ve en el panel y teclea una vez en el datáfono. */
export function newPairingCode(): string {
  return Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join(
    '',
  );
}

/** Lo que teclea la persona ("abcd-2345") → "ABCD2345". */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "ABCD2345" → "ABCD-2345" para leerlo mejor. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Credencial del datáfono: se entrega una vez y solo se guarda su hash. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Caducidad de la credencial del datáfono (POS_DEVICE_TOKEN_MAX_AGE_DAYS, en
 * días). Vacío, 0 o inválido = no caduca: es lo de por defecto para no dejar
 * sin servicio datáfonos que aún no rotan su credencial.
 */
export function deviceTokenMaxAgeMs(raw: string | undefined): number | null {
  const days = Number((raw ?? '').trim());
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
}

/** ¿Ha caducado una credencial entregada en `issuedAt`? Sin fecha, no. */
export function deviceTokenExpired(issuedAt: Date | null, now: Date, maxAgeMs: number | null): boolean {
  if (maxAgeMs === null || !issuedAt) return false;
  return now.getTime() - issuedAt.getTime() > maxAgeMs;
}

/** Operación del cierre de jornada del datáfono (para cuadrar). */
export const PaytefShiftOperationSchema = z
  .object({
    paytefOperationNumber: z.union([z.string().min(1).max(64), z.number().int().nonnegative()]),
    opType: z.string().max(20).optional(),
    amountWithSign: z.union([z.number(), z.string()]).optional(),
    timestamp: z.string().max(64).optional(),
  })
  .passthrough();
export type PaytefShiftOperation = z.infer<typeof PaytefShiftOperationSchema>;

/**
 * Importe de una operación del cierre en céntimos. Paytef da números enteros
 * en céntimos (como requestedAmount); si llegara texto con decimales ("12,50"),
 * son euros.
 */
export function shiftAmountCents(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = v.trim().replace(',', '.');
  if (s === '' || Number.isNaN(Number(s))) return null;
  return /\./.test(s) ? Math.round(Number(s) * 100) : Math.round(Number(s));
}
