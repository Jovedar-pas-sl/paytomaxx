import type { StallRef } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import { isPartyEdition } from '../../config/edition';

/**
 * OxioParty: cada cobro (tarjeta o QR, saldo, pulsera, cuenta con varias
 * líneas) y cada consumo del saldo lleva la caseta de la persona del personal
 * que lo crea, fijada en ese momento (si luego cambia de caseta, lo ya cobrado
 * no cambia). Con EDITION=club no se mira nada y no se escribe nada.
 */

/**
 * La caseta de quien crea el cobro, o null (OxioPay, sin persona o sin
 * caseta). Solo si la persona es de ese local: un super-admin que cobra en
 * otro local no lleva allí su caseta (la clave ajena lo impediría).
 */
export async function stallIdForStaff(
  db: Pick<TransactionalClient, 'user'>,
  who: { tenantId: string; userId: string | null | undefined },
): Promise<string | null> {
  if (!isPartyEdition() || !who.userId) return null;
  const user = await db.user.findFirst({ where: { id: who.userId, tenantId: who.tenantId }, select: { stallId: true } });
  return user?.stallId ?? null;
}

/**
 * La caseta de quien llama, corta (`{ id, name }`), para «me». stalls tiene
 * FORCE RLS: se lee dentro de withTenant. OxioPay: null sin mirar la base.
 */
export async function myStall(
  prisma: Pick<PrismaService, 'withTenant'>,
  who: { tenantId: string; userId: string },
): Promise<StallRef | null> {
  if (!isPartyEdition()) return null;
  const row = await prisma.withTenant(who.tenantId, (tx) =>
    tx.user.findFirst({ where: { id: who.userId, tenantId: who.tenantId }, select: { stall: { select: { id: true, name: true } } } }),
  );
  return row?.stall ?? null;
}

/**
 * Para el `data` de Prisma: `{ stallId }` solo si hay caseta. Sin ella no se
 * añade nada (lo que escribe OxioPay queda exactamente igual que antes).
 */
export function stallSeal(stallId: string | null | undefined): { stallId: string } | Record<string, never> {
  return stallId ? { stallId } : {};
}
