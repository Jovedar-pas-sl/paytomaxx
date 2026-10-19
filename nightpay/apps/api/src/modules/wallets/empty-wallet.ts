import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import { newWalletCode, newWalletToken } from './wallet-rules';

/** Intentos de código corto al crear el saldo de una recarga. */
const MAX_WALLET_CODE_ATTEMPTS = 5;

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Saldo vacío para una recarga (con tarjeta o en efectivo), dentro de la
 * transacción de la recarga. Código corto único entre los activos: si coincide
 * se prueba otro, sin romper la transacción (ON CONFLICT con el índice
 * parcial del código).
 */
export async function insertEmptyWallet(
  tx: RawTx,
  tenantId: string,
  input: { identifier: string | null; walletGroup: string | null },
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_WALLET_CODE_ATTEMPTS; attempt += 1) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO client_wallets ("tenantId", identifier, "qrToken", "shortCode", "walletGroup", "updatedAt")
      VALUES (${tenantId}::uuid, ${input.identifier}, ${newWalletToken()}, ${newWalletCode()}, ${input.walletGroup}, NOW())
      ON CONFLICT ("shortCode") WHERE status = 'ACTIVE' AND "shortCode" IS NOT NULL DO NOTHING
      RETURNING id::text AS id
    `;
    const created = rows[0];
    if (created) return created.id;
  }
  throw new ConflictException('No se pudo crear el saldo: inténtalo otra vez');
}
