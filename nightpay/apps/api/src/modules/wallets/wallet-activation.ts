import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import { newWalletCode } from './wallet-rules';

/** Lo que hace falta del tx: consultas crudas (con bypass de RLS). */
type CodeTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Intentos para dar con un código libre al reabrir un saldo (31^6 combinaciones). */
const MAX_FREE_CODE_ATTEMPTS = 5;

/**
 * Qué cambiar para que un saldo vuelva a estar ACTIVO (lo que le devuelven o
 * le suman lo reabre). El código corto solo es único entre los saldos activos
 * (índice client_wallets_shortCode_active_key): mientras estaba a 0 o cerrado
 * se lo pudo llevar otro cliente. Si está cogido, se le da uno nuevo (el
 * cliente lo ve en su página; su ficha y su Face ID van por el saldo, no por
 * el código). Llamar con el saldo bloqueado (FOR UPDATE) y aplicar el
 * resultado en el mismo UPDATE que le suma el dinero.
 */
export async function reopenData(
  tx: CodeTx,
  wallet: { id: string; shortCode: string | null; status: string },
): Promise<{ status?: 'ACTIVE'; shortCode?: string }> {
  if (wallet.status === 'ACTIVE') return {};
  if (wallet.shortCode === null) return { status: 'ACTIVE' };
  return { status: 'ACTIVE', shortCode: await freeCode(tx, wallet.id, wallet.shortCode) };
}

async function freeCode(tx: CodeTx, walletId: string, current: string): Promise<string> {
  if (!(await codeTaken(tx, current, walletId))) return current;
  for (let attempt = 0; attempt < MAX_FREE_CODE_ATTEMPTS; attempt += 1) {
    const candidate = newWalletCode();
    if (!(await codeTaken(tx, candidate, walletId))) return candidate;
  }
  throw new ConflictException('No se ha podido dar un código libre a este saldo: inténtalo otra vez');
}

async function codeTaken(tx: CodeTx, code: string, walletId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM client_wallets
     WHERE "shortCode" = ${code} AND status = 'ACTIVE' AND id <> ${walletId}::uuid
     LIMIT 1
  `;
  return rows.length > 0;
}
