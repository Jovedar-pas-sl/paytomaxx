import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';

/**
 * Saldos sumados (mergedIntoId): una recarga nueva se suma al saldo de la
 * Face ID del cliente; la recarga queda a 0 apuntando a aquel. Lo que vuelva
 * a esa recarga (un consumo anulado) va al saldo que usa hoy el cliente, y
 * lo que se le devuelva a la tarjeta sale de las recargas de toda la cadena.
 * Llamar dentro de una transacción con bypass de RLS (acrossVenues).
 */

type ChainTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Saltos como mucho (en la práctica, 0 o 1): corta una cadena rota o un ciclo. */
const MAX_MERGE_HOPS = 10;

export interface LockedWallet {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  balanceCents: number;
  status: string;
  shortCode: string | null;
  mergedIntoId: string | null;
}

/**
 * El saldo donde está hoy el dinero de `walletId` (él mismo o aquel al que
 * se sumó), bloqueado (FOR UPDATE). Solo se bloquea ese: los de en medio se
 * leen sin bloquear y, si justo se suma a otro mientras, se sigue la cadena.
 * null si no existe.
 */
export async function lockLiveWallet(tx: ChainTx, walletId: string): Promise<LockedWallet | null> {
  let id = walletId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
    const peek = await tx.$queryRaw<Array<{ mergedIntoId: string | null }>>`
      SELECT "mergedIntoId" FROM client_wallets WHERE id = ${id}::uuid
    `;
    if (!peek[0]) return null;
    const next = peek[0].mergedIntoId;
    if (next) {
      id = next;
      continue;
    }
    const rows = await tx.$queryRaw<LockedWallet[]>`
      SELECT id, "tenantId", "walletGroup", "balanceCents", status::text AS status, "shortCode", "mergedIntoId"
        FROM client_wallets WHERE id = ${id}::uuid FOR UPDATE
    `;
    const wallet = rows[0];
    if (!wallet) return null;
    if (!wallet.mergedIntoId) return wallet;
    id = wallet.mergedIntoId;
  }
  throw new ConflictException('Este saldo se ha sumado a otros demasiadas veces: avisa al encargado');
}

/** El saldo y todos los que se sumaron a él (a cualquier profundidad). */
export async function mergedWalletIds(tx: ChainTx, targetWalletId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE chain AS (
      SELECT id, 0 AS hops FROM client_wallets WHERE id = ${targetWalletId}::uuid
      UNION ALL
      SELECT w.id, c.hops + 1 FROM client_wallets w JOIN chain c ON w."mergedIntoId" = c.id
       WHERE c.hops < ${MAX_MERGE_HOPS}
    )
    SELECT DISTINCT id::text AS id FROM chain
  `;
  return rows.map((r) => r.id);
}
