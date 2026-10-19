import { z } from 'zod';

/**
 * Recepción (20261021100000): recargar el saldo del cliente con tarjeta (el
 * datáfono, o el QR en un móvil) o en efectivo, darle una ficha NFC y que
 * elija su PIN. Lo usan el API, la pantalla del datáfono (/pax) y la app del
 * personal (Android, con Web NFC).
 */

/**
 * Tope de una recarga en efectivo: 1.000 €. En España un pago en efectivo en
 * el que una de las partes es un negocio no puede llegar a 1.000 € (Ley
 * 11/2021, art. 7 de la Ley 7/2012); más, con tarjeta.
 */
export const MAX_CASH_TOP_UP_CENTS = 99_999;

/**
 * Los pagos troceados de una misma operación suman (art. 7.1 de la Ley
 * 7/2012): el efectivo que entra en un saldo (y en los sumados a él) en 24 h
 * no puede llegar a 1.000 €. Lo mismo para el efectivo que se devuelve.
 */
export const CASH_LIMIT_CENTS = 100_000;
export const CASH_LIMIT_WINDOW_HOURS = 24;

/** Una recarga en efectivo mal tecleada se anula en este tiempo (después, «Me voy» o el dueño). */
export const CASH_TOP_UP_VOID_WINDOW_MINUTES = 120;

/** Una Idempotency-Key por intento: la genera la pantalla y la repite si se reintenta. */
export const IdempotencyKeySchema = z.string().trim().min(8).max(100);

const CardTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
const CardUidSchema = z.string().trim().max(64).optional();

/** El saldo que se recarga: uno nuevo, el de su código o el de su ficha. */
export const TopUpWalletSchema = z.union([
  z.object({ create: z.literal(true), identifier: z.string().trim().max(60).optional() }).strict(),
  z.object({ code: z.string().trim().min(6).max(10) }).strict(),
  z.object({ card: CardTokenSchema, uid: CardUidSchema }).strict(),
]);
export type TopUpWalletDto = z.infer<typeof TopUpWalletSchema>;

export const CashTopUpSchema = z.object({
  amountCents: z.number().int().positive().max(MAX_CASH_TOP_UP_CENTS, 'En efectivo, como mucho 999,99 € por recarga'),
  idempotencyKey: IdempotencyKeySchema,
  wallet: TopUpWalletSchema,
});
export type CashTopUpDto = z.infer<typeof CashTopUpSchema>;

/** Anular una recarga en efectivo reciente (encargado o dueño, con su 2FA). */
export const CashTopUpVoidSchema = z.object({
  reason: z.string().trim().min(3, 'Explica por qué se anula').max(200),
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
export type CashTopUpVoidDto = z.infer<typeof CashTopUpVoidSchema>;

/** Lo que devuelve la anulación: la fila negativa y el saldo que queda. */
export interface CashTopUpVoidResult {
  voidId: string;
  topUpId: string;
  walletId: string;
  /** Lo anulado (positivo): sale de la caja. */
  amountCents: number;
  balanceCents: number;
}

/** Recarga con tarjeta en el datáfono de recepción: el importe y el saldo (no hay efectivo). */
export const DeviceCardTopUpSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_00),
  idempotencyKey: IdempotencyKeySchema,
  wallet: z.union([
    z.object({ create: z.literal(true) }).strict(),
    z.object({ card: CardTokenSchema, uid: CardUidSchema }).strict(),
  ]),
});
export type DeviceCardTopUpDto = z.infer<typeof DeviceCardTopUpSchema>;

/** Lo que devuelve una recarga en efectivo: ya está sumada. */
export interface CashTopUpResult {
  topUpId: string;
  walletId: string;
  /** Código del saldo (K7Q-4M2): el cliente lo apunta. */
  code: string;
  amountCents: number;
  balanceCents: number;
  /** Saldo nuevo (no tenía). */
  createdWallet: boolean;
  /** La misma recarga pedida otra vez (mismo botón): no se ha cargado dos veces. */
  replayed: boolean;
}

/** Qué ofrece la recepción en este local y en este aparato. */
export interface ReceptionOptions {
  /** Recarga con tarjeta (en el datáfono: «Datáfono» y «Saldo» encendidos). */
  card: boolean;
  /** Recarga en efectivo (encendida y con permiso). */
  cash: boolean;
  /** Por qué no hay efectivo (null si lo hay). */
  cashBlockedReason: string | null;
  /** Fichas NFC encendidas. */
  nfc: boolean;
}
