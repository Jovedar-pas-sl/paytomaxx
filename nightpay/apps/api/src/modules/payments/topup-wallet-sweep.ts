import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Una recarga con «saldo nuevo» crea el saldo vacío al crear el cobro (para
 * darle ficha y PIN en cuanto se pague). Si el cobro acaba sin pagarse
 * (caducado o cancelado: p. ej. una venta denegada en el datáfono y nadie
 * la reintenta), ese saldo vacío se cierra (EXPIRED): deja libre su código y
 * no sale entre los saldos activos.
 *
 * Solo el saldo que nació con ESTE cobro y que sigue sin nada: a 0, sin PIN,
 * sin ficha dada, sin efectivo, sin otro cobro y sin otro saldo sumado a él.
 * Dentro de transition(), con la fila del cobro bloqueada. Devuelve si lo cerró.
 */
export async function sweepUnpaidTopUpWallet(
  tx: TransactionalClient,
  paymentId: string,
  walletId: string,
): Promise<boolean> {
  const closed = await tx.$executeRaw`
    UPDATE client_wallets w
       SET status = 'EXPIRED'::"WalletStatus", "updatedAt" = now()
      FROM payments p
     WHERE p.id = ${paymentId}::uuid
       AND w.id = ${walletId}::uuid
       AND p."walletId" = w.id
       AND w.status = 'ACTIVE'::"WalletStatus"
       AND w."balanceCents" = 0
       AND w."pinHash" IS NULL
       AND w."mergedIntoId" IS NULL
       AND w."createdAt" >= p."createdAt" - interval '1 minute'
       AND NOT EXISTS (SELECT 1 FROM payments o WHERE o."walletId" = w.id AND o.id <> p.id)
       AND NOT EXISTS (SELECT 1 FROM wallet_cash_topups c WHERE c."walletId" = w.id)
       AND NOT EXISTS (SELECT 1 FROM wallet_cards k WHERE k."walletId" = w.id AND k.status = 'ISSUED')
       AND NOT EXISTS (SELECT 1 FROM client_wallets m WHERE m."mergedIntoId" = w.id)
  `;
  return closed > 0;
}
