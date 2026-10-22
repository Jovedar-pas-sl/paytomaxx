import { createHash } from 'node:crypto';
import type { TopUpWalletDto } from '@nightpay/contracts';
import { normalizeWalletCode } from './wallet-rules';

/**
 * Huella de lo que pidió la pantalla con una Idempotency-Key de recarga en
 * efectivo: el destino tal como se pidió (saldo nuevo, el de este código o el
 * de esta ficha) y el importe. Es la PETICIÓN, no el saldo al que acabó
 * yendo: si después ese saldo se suma a otro o cambia de código, el mismo
 * reintento sigue siendo el mismo. La etiqueta del saldo nuevo y el UID leído
 * de la ficha no cambian el destino y no cuentan.
 */
export function cashIntentFingerprint(input: { amountCents: number; wallet: TopUpWalletDto }): string {
  const target =
    'create' in input.wallet
      ? ['create']
      : 'code' in input.wallet
        ? ['code', normalizeWalletCode(input.wallet.code)]
        : ['card', input.wallet.card];
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, amountCents: input.amountCents, target }))
    .digest('hex');
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
