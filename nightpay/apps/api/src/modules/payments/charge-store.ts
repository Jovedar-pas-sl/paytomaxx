import type { TransactionalClient } from '../../common/prisma/prisma.service';
import type { DraftLine } from './charge-lines';
import type { InvitationEarning } from './invitation-lines';

/**
 * Lo que el mapa del dinero guarda en la base, siempre dentro de una
 * transacción de PrismaService (payment_lines y charge_ref_counters tienen
 * FORCE RLS): las líneas de cada cobro y su referencia corta.
 */

/**
 * La siguiente referencia del local (1, 2, 3…), compartida por los cobros con
 * tarjeta y los del saldo, puesta en el cobro ya guardado (y en su gemelo del
 * saldo) en UNA sentencia: la última de la transacción del cobro. La fila del
 * contador queda bloqueada solo hasta el commit; antes se tomaba al principio
 * y, con muchos cobros a la vez, todo el local esperaba en fila mientras cada
 * uno guardaba lo demás (carga del 19-11-2026). Dos cobros a la vez no se
 * llevan la misma, y si el cobro no se guarda, la referencia tampoco se gasta.
 */
export async function assignChargeRef(
  tx: TransactionalClient,
  tenantId: string,
  rows: { paymentId?: string | null; walletChargeId?: string | null },
): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ ref: number }>>`
    WITH counter AS (
      INSERT INTO charge_ref_counters ("tenantId", "lastRef", "updatedAt")
      VALUES (${tenantId}::uuid, 1, now())
      ON CONFLICT ("tenantId") DO UPDATE SET "lastRef" = charge_ref_counters."lastRef" + 1, "updatedAt" = now()
      RETURNING "lastRef"
    ), payment AS (
      UPDATE payments SET ref = (SELECT "lastRef" FROM counter) WHERE id = ${rows.paymentId ?? null}::uuid
    ), saldo AS (
      UPDATE wallet_charge_requests SET ref = (SELECT "lastRef" FROM counter) WHERE id = ${rows.walletChargeId ?? null}::uuid
    )
    SELECT "lastRef" AS ref FROM counter
  `;
  if (!row) throw new Error(`Sin referencia del contador del local ${tenantId}`);
  return row.ref;
}

/** De dónde son las líneas: un cobro con tarjeta o un cobro del saldo. */
export type LineSource = { paymentId: string } | { walletChargeId: string };

export async function insertChargeLines(
  tx: TransactionalClient,
  tenantId: string,
  source: LineSource,
  lines: readonly DraftLine[],
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
      beneficiaryOperatorId: l.beneficiaryOperatorId ?? null,
      beneficiaryCents: l.beneficiaryCents ?? null,
      chargerCents: l.chargerCents ?? null,
      serviceOperatorId: l.serviceOperatorId ?? null,
    })),
  });
}

export interface StoredLine {
  id: string;
  paymentId: string | null;
  walletChargeId: string | null;
  category: string;
  serviceItemId: string | null;
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  operatorCommissionBps: number | null;
  beneficiaryOperatorId: string | null;
  beneficiaryCents: number | null;
  chargerCents: number | null;
  serviceOperatorId: string | null;
}

const LINE_SELECT = {
  id: true,
  paymentId: true,
  walletChargeId: true,
  category: true,
  serviceItemId: true,
  label: true,
  qty: true,
  unitCents: true,
  amountCents: true,
  operatorCommissionBps: true,
  beneficiaryOperatorId: true,
  beneficiaryCents: true,
  chargerCents: true,
  serviceOperatorId: true,
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

/** La compañera a cuyo nombre se cobró el servicio (cobro por el encargado). */
export interface ServedOperator {
  id: string;
  name: string | null;
}

/**
 * La compañera del servicio de cada cobro (la de su primera línea con
 * serviceOperatorId), por id del cobro con tarjeta o del saldo. Dentro de una
 * transacción (payment_lines tiene FORCE RLS). En el cobro único las líneas
 * siguen en el cobro con tarjeta hasta que paga el saldo (cobro-link.ts): para
 * un cobro del saldo, pasa su id y el de su linkedPaymentId.
 */
export async function servedOperators(
  tx: TransactionalClient,
  ids: { paymentIds?: ReadonlyArray<string | null>; walletChargeIds?: ReadonlyArray<string | null> },
): Promise<Map<string, ServedOperator>> {
  const paymentIds = (ids.paymentIds ?? []).filter((id): id is string => Boolean(id));
  const walletChargeIds = (ids.walletChargeIds ?? []).filter((id): id is string => Boolean(id));
  if (paymentIds.length === 0 && walletChargeIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ chargeId: string; id: string; name: string | null }>>`
    SELECT DISTINCT ON (COALESCE(l."paymentId", l."walletChargeId"))
           COALESCE(l."paymentId", l."walletChargeId")::text AS "chargeId",
           u.id::text AS id, NULLIF(btrim(u."displayName"), '') AS name
      FROM payment_lines l
      JOIN users u ON u.id = l."serviceOperatorId"
     WHERE l."serviceOperatorId" IS NOT NULL
       AND (l."paymentId" = ANY(${paymentIds}::uuid[]) OR l."walletChargeId" = ANY(${walletChargeIds}::uuid[]))
     ORDER BY COALESCE(l."paymentId", l."walletChargeId"), l."createdAt", l.id
  `;
  return new Map(rows.map((r) => [r.chargeId, { id: r.id, name: r.name }]));
}

/**
 * Las ganancias de las invitaciones de un cobro con tarjeta (paymentId) o de
 * un consumo del saldo (consumptionId), en la misma transacción que lo cobra:
 * una por persona y cobro. Si esa persona ya tiene ganancia en este cobro
 * (p. ej. la propina que le dejaron), se le suma su parte.
 */
export async function insertInvitationEarnings(
  tx: TransactionalClient,
  tenantId: string,
  source: { paymentId: string } | { consumptionId: string },
  earnings: ReadonlyArray<InvitationEarning>,
): Promise<void> {
  for (const e of earnings) {
    if ('paymentId' in source) {
      await tx.$executeRaw`
        INSERT INTO operator_earnings (
          "tenantId", "operatorId", "paymentId", "paymentLineId",
          "paymentAmountCents", "commissionBps", "commissionCents"
        ) VALUES (
          ${tenantId}::uuid, ${e.operatorId}::uuid, ${source.paymentId}::uuid, ${e.paymentLineId}::uuid,
          ${e.paymentAmountCents}::int, ${e.commissionBps}::int, ${e.commissionCents}::int
        )
        ON CONFLICT ("paymentId", "operatorId") DO UPDATE
          SET "commissionCents" = operator_earnings."commissionCents" + EXCLUDED."commissionCents",
              "commissionBps" = EXCLUDED."commissionBps",
              "paymentAmountCents" = EXCLUDED."paymentAmountCents",
              "paymentLineId" = EXCLUDED."paymentLineId"
      `;
    } else {
      await tx.$executeRaw`
        INSERT INTO operator_earnings (
          "tenantId", "operatorId", "consumptionId", "paymentLineId",
          "paymentAmountCents", "commissionBps", "commissionCents"
        ) VALUES (
          ${tenantId}::uuid, ${e.operatorId}::uuid, ${source.consumptionId}::uuid, ${e.paymentLineId}::uuid,
          ${e.paymentAmountCents}::int, ${e.commissionBps}::int, ${e.commissionCents}::int
        )
        ON CONFLICT ("consumptionId", "operatorId") DO UPDATE
          SET "commissionCents" = operator_earnings."commissionCents" + EXCLUDED."commissionCents",
              "commissionBps" = EXCLUDED."commissionBps",
              "paymentAmountCents" = EXCLUDED."paymentAmountCents",
              "paymentLineId" = EXCLUDED."paymentLineId"
      `;
    }
  }
}
