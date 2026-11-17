import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Lo que queda de la salida de recepción, que ya no devuelve el saldo
 * (saldo-rule.ts): una petición que recepción dejó para el encargado antes
 * del cambio (más de 100 €, su tope de la noche…) se termina en el panel y el
 * encargado la confirma con su 2FA aunque sea poco. Mira la petición viva:
 * desde que se pidió (con un margen, el registro lleva la hora de su
 * transacción).
 */
export async function receptionAskedManager(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  walletId: string,
  closeRequestedAt: Date | null,
): Promise<boolean> {
  if (!closeRequestedAt) return false;
  const since = new Date(closeRequestedAt.getTime() - REQUEST_MARGIN_MS);
  const rows = await tx.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS found FROM audit_events
     WHERE action = 'wallet.close_requested'
       AND "targetType" = 'ClientWallet' AND "targetId" = ${walletId}
       AND payload ->> 'managerRequired' = 'true'
       AND "occurredAt" >= ${since}
     LIMIT 1
  `;
  return rows[0]?.found === 1;
}

const REQUEST_MARGIN_MS = 5 * 60 * 1000;
