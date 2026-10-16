import type { Prisma } from '@nightpay/db';

/**
 * Qué pases hay que poner al día. En vez de avisar desde cada sitio donde
 * cambia el saldo (cobros, recargas, devoluciones, sumar…), un repaso cada
 * ~2 min compara cada pase con su saldo: si el saldo, su estado o su enlace
 * ya no son los que se mandaron a Google, toca.
 */

/** Cada cuánto corre el repaso. */
export const GOOGLE_WALLET_SYNC_EVERY_MS = 2 * 60 * 1000;
/** Como mucho tantos pases por repaso (el resto, en el siguiente). */
export const GOOGLE_WALLET_SYNC_BATCH = 100;

export interface DuePass {
  id: string;
  objectId: string;
  lastSyncedBalanceCents: number;
  lastSyncedStatus: string;
  balanceCents: number;
  status: string;
  merged: boolean;
  /** El enlace del saldo es el mismo con el que se hizo el pase. */
  sameLink: boolean;
  /** El enlace actual (para el QR si hay que volver a crear el pase en Google). */
  qrToken: string;
  venueName: string | null;
}

export type SyncAction = 'update' | 'revoke' | 'skip';

/**
 * Enlace nuevo (el dueño lo cambió: móvil perdido…) → el pase viejo se
 * apaga y no recibe más el saldo. Si no, saldo o estado distintos → se
 * actualiza. Lo demás ya está al día.
 */
export function syncAction(pass: DuePass): SyncAction {
  if (!pass.sameLink) return 'revoke';
  if (pass.balanceCents !== pass.lastSyncedBalanceCents || pass.status !== pass.lastSyncedStatus) return 'update';
  return 'skip';
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Los pases de Google sin apagar cuyo saldo, estado o enlace cambió: primero
 * los que nunca se intentaron y luego los que llevan más tiempo sin intentarse
 * (uno que falla siempre va al final y no tapa a los demás). Lee
 * client_wallets (FORCE RLS): hay que llamarla dentro de prisma.asSystem. El hash del enlace se calcula en
 * Postgres (sha256 del texto), igual que linkHash() en el API.
 */
export async function findDuePasses(tx: RawTx, limit: number = GOOGLE_WALLET_SYNC_BATCH): Promise<DuePass[]> {
  return tx.$queryRaw<DuePass[]>`
    SELECT p.id::text AS id,
           p."objectId",
           p."lastSyncedBalanceCents",
           p."lastSyncedStatus"::text AS "lastSyncedStatus",
           w."balanceCents",
           w.status::text AS status,
           (w."mergedIntoId" IS NOT NULL) AS merged,
           (p."tokenHash" = encode(sha256(convert_to(w."qrToken", 'UTF8')), 'hex')) AS "sameLink",
           w."qrToken",
           v.name AS "venueName"
      FROM wallet_passes p
      JOIN client_wallets w ON w.id = p."walletId"
      LEFT JOIN venues v ON v.id = w."tenantId"
     WHERE p.provider = 'GOOGLE'
       AND p."revokedAt" IS NULL
       AND (p."lastSyncedBalanceCents" <> w."balanceCents"
            OR p."lastSyncedStatus" <> w.status
            OR p."tokenHash" <> encode(sha256(convert_to(w."qrToken", 'UTF8')), 'hex'))
     ORDER BY p."lastAttemptAt" ASC NULLS FIRST, p."lastSyncedAt" ASC
     LIMIT ${limit}
  `;
}
