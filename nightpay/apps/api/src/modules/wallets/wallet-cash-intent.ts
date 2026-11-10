import { createHash } from 'node:crypto';
import type { TopUpWalletDto } from '@nightpay/contracts';
import { normalizeWalletCode } from './wallet-rules';

/**
 * La ficha buscada por su número impreso en recepción (su id; nunca llega así
 * del cliente): FichaNumbersService la pasa a CashTopUpService.
 */
export type PrintedTopUpRef = { printed: { cardId: string } };

/**
 * Las recargas por número impreso llevan la huella marcada: no prueban que la
 * ficha estuviera delante, y el QR de activación (WalletActivationLinkService)
 * no las cuenta.
 */
export const PRINTED_INTENT_PREFIX = 'printed:';

/**
 * Huella de lo que pidió la pantalla con una Idempotency-Key de recarga en
 * efectivo: el destino tal como se pidió (saldo nuevo, el de este código, el
 * de esta ficha o el de la ficha de este número impreso) y el importe. Es la
 * PETICIÓN, no el saldo al que acabó yendo: si después ese saldo se suma a
 * otro o cambia de código, el mismo reintento sigue siendo el mismo. La
 * etiqueta del saldo nuevo y el UID leído de la ficha no cambian el destino y
 * no cuentan.
 */
export function cashIntentFingerprint(input: { amountCents: number; wallet: TopUpWalletDto | PrintedTopUpRef }): string {
  const w = input.wallet;
  const target =
    'create' in w
      ? // Con su ficha nueva: otra ficha es otra recarga (sin ficha, como siempre).
        w.card
        ? ['create', 'card', w.card]
        : ['create']
      : 'code' in w
        ? ['code', normalizeWalletCode(w.code)]
        : 'printed' in w
          ? ['printed', w.printed.cardId]
          : ['card', w.card];
  const hash = createHash('sha256')
    .update(JSON.stringify({ v: 1, amountCents: input.amountCents, target }))
    .digest('hex');
  return 'printed' in w ? `${PRINTED_INTENT_PREFIX}${hash}` : hash;
}

/**
 * La ficha nueva ya cargada, leída otra vez con la misma clave (S-4): la
 * pantalla falló tras la recarga y, al repetirla, la ficha ya es un saldo, así
 * que ahora se pide «a esta ficha» y no «saldo nuevo con esta ficha». Es la
 * misma recarga (el destino es la ficha): solo si aquella creó el saldo con
 * esa misma ficha y el mismo importe.
 */
export function isNewCardRetry(
  existing: { intentFingerprint: string | null; createdWallet: boolean },
  input: { amountCents: number; wallet: TopUpWalletDto | PrintedTopUpRef },
): boolean {
  const w = input.wallet;
  if (!existing.createdWallet || !existing.intentFingerprint || !('card' in w) || 'create' in w) return false;
  return existing.intentFingerprint === cashIntentFingerprint({ amountCents: input.amountCents, wallet: { create: true, card: w.card } });
}

/** ¿Esta recarga se hizo por el número impreso (sin la ficha delante)? */
export function isPrintedIntent(fingerprint: string | null | undefined): boolean {
  return typeof fingerprint === 'string' && fingerprint.startsWith(PRINTED_INTENT_PREFIX);
}

/** Lo que se enseñó al cobrarla: con él, un reintento devuelve el mismo recibo. */
export interface CashTopUpReceipt {
  code: string;
  balanceCents: number;
}

/** El recibo guardado en la fila (null en las anteriores a guardarlo o si no se lee). */
export function storedReceipt(value: unknown): CashTopUpReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { code, balanceCents } = value as Record<string, unknown>;
  if (typeof code !== 'string' || typeof balanceCents !== 'number' || !Number.isInteger(balanceCents)) return null;
  return { code, balanceCents };
}
