import type { TransactionalClient } from '../../common/prisma/prisma.service';
import type { DraftLine } from './charge-lines';

/**
 * Lo que el mapa del dinero guarda en la base, siempre dentro de una
 * transacción de PrismaService (payment_lines y charge_ref_counters tienen
 * FORCE RLS): las líneas de cada cobro y su referencia corta.
 */

/**
 * La siguiente referencia del local (1, 2, 3…), compartida por los cobros con
 * tarjeta y los del saldo. La fila del contador queda bloqueada hasta el
 * commit: dos cobros a la vez no se llevan la misma, y si el cobro no se
 * guarda, la referencia tampoco se gasta.
 */
export async function nextChargeRef(tx: TransactionalClient, tenantId: string): Promise<number> {
  // Upsert nativo de Prisma: INSERT … ON CONFLICT ("tenantId") DO UPDATE SET
  // "lastRef" = "lastRef" + 1 RETURNING, en una sola sentencia.
  const row = await tx.chargeRefCounter.upsert({
    where: { tenantId },
    create: { tenantId, lastRef: 1 },
    update: { lastRef: { increment: 1 } },
    select: { lastRef: true },
  });
  return row.lastRef;
}

/** De dónde son las líneas: un cobro con tarjeta o un cobro del saldo. */
export type LineSource = { paymentId: string } | { walletChargeId: string };

export async function insertChargeLines(
  tx: TransactionalClient,
  tenantId: string,
  source: LineSource,
  lines: ReadonlyArray<DraftLine & { operatorCommissionBps?: number | null }>,
): Promise<void> {
  if (lines.length === 0) return;
  await tx.paymentLine.createMany({
    data: lines.map((l) => ({
      tenantId,
      ...source,
      category: l.category,
      serviceItemId: l.serviceItemId,
      label: l.label,
      qty: l.qty,
      unitCents: l.unitCents,
      amountCents: l.amountCents,
      operatorCommissionBps: l.operatorCommissionBps ?? null,
    })),
  });
}

export interface StoredLine {
  paymentId: string | null;
  walletChargeId: string | null;
  category: string;
  serviceItemId: string | null;
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  operatorCommissionBps: number | null;
}

const LINE_SELECT = {
  paymentId: true,
  walletChargeId: true,
  category: true,
  serviceItemId: true,
  label: true,
  qty: true,
  unitCents: true,
  amountCents: true,
  operatorCommissionBps: true,
} as const;

/** Las líneas de esos cobros (en el orden en que se guardaron). */
export async function linesOf(
  tx: TransactionalClient,
  ids: { paymentIds?: readonly string[]; walletChargeIds?: readonly string[] },
): Promise<StoredLine[]> {
  const or = [
    ...(ids.paymentIds && ids.paymentIds.length > 0 ? [{ paymentId: { in: [...ids.paymentIds] } }] : []),
    ...(ids.walletChargeIds && ids.walletChargeIds.length > 0 ? [{ walletChargeId: { in: [...ids.walletChargeIds] } }] : []),
  ];
  if (or.length === 0) return [];
  return tx.paymentLine.findMany({ where: { OR: or }, orderBy: [{ createdAt: 'asc' }, { amountCents: 'desc' }, { id: 'asc' }], select: LINE_SELECT });
}
