import { z } from 'zod';
import { IdempotencyKeySchema } from './reception';

/**
 * «Recargar saldo» (Inicio) y la recepción: el saldo que se recarga se dice
 * con su NFC (tarjeta, ficha o pulsera; lo recomendado, antes de cobrar) o
 * con su código (K7Q-4M2).
 *
 * Plan B: si su NFC no se pudo leer antes, se cobra primero. La recarga
 * queda «pendiente de asignar» (su dinero en un saldo propio, nunca se
 * pierde) hasta que alguien acerca su NFC o teclea su código; mientras, sale
 * en Incidencias y se asigna desde Recepción o desde el panel.
 */

const CardToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Este NFC no es nuestro');
const CardUid = z.string().trim().max(64).optional();
const WalletCode = z.string().trim().min(6).max(10);

/** El saldo, por su NFC o por su código. */
export const SaldoRefSchema = z.union([
  z.object({ card: CardToken, uid: CardUid }).strict(),
  z.object({ code: WalletCode }).strict(),
]);
export type SaldoRefDto = z.infer<typeof SaldoRefSchema>;

/** Cobrar primero (sin su NFC): una recarga con tarjeta que queda pendiente de asignar. */
export const PendingTopUpStartSchema = z
  .object({
    amountCents: z.number().int().positive().max(10_000_00, 'Como mucho 10.000 € por recarga'),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type PendingTopUpStartDto = z.infer<typeof PendingTopUpStartSchema>;

/** Una recarga cobrada que espera a sumarse al saldo de su cliente. */
export interface PendingTopUpView {
  /** El saldo provisional donde está el dinero. */
  walletId: string;
  /** Lo que hay en él (lo cobrado). */
  amountCents: number;
  /** Cuándo se cobró sin el NFC. */
  since: string;
  /** Quién la cobró (null si ya no está). */
  byName: string | null;
}

/** La recarga ya sumada al saldo del cliente. */
export interface AssignedTopUp {
  /** El saldo del cliente. */
  walletId: string;
  /** «K7Q-•••». */
  codeHint: string;
  amountCents: number;
  /** Lo que tiene ahora. */
  balanceCents: number;
}

/** Minutos que una recarga pendiente espera antes de salir en Incidencias (la chica suele asignarla al momento). */
export const PENDING_TOPUP_INCIDENT_MINUTES = 10;
