import { ConflictException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { payoutCutoff } from './payout-math';

/**
 * Qué entra en un pago a una chica, leído DENTRO de la transacción del pago
 * (o de la petición de pago) con las filas bloqueadas. Lo usan createPayout y
 * «Por aprobar» (la petición fija estas comisiones y deudas; al aprobarla se
 * pagan exactamente ellas).
 */

export interface PayableEarningRow {
  id: string;
  commissionCents: number;
  tipCents: number;
  reversedCents: number;
}

export interface OpenDebtRow {
  id: string;
  reversedDeltaCents: number;
}

/**
 * Candado por chica hasta el final de la transacción: un pago, una petición
 * de pago y su aprobación de la misma chica van de una en una.
 */
export async function lockOperatorPayouts(tx: TransactionalClient, operatorId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`payout-operator:${operatorId}`}))`;
}

/**
 * Comisiones sin pagar de la chica creadas hasta `cutoff` (las que ya pasaron
 * los días de espera del local), bloqueadas. Incluye la propina.
 */
export async function lockPayableEarnings(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  cutoff: Date,
): Promise<PayableEarningRow[]> {
  return tx.$queryRaw<PayableEarningRow[]>`
    SELECT id, "commissionCents", "tipCents", "reversedCents"
      FROM operator_earnings
     WHERE "operatorId" = ${operatorId}::uuid
       AND "tenantId" = ${tenantId}::uuid
       AND "payoutId" IS NULL
       AND "createdAt" <= ${cutoff}
     ORDER BY id
     FOR UPDATE
  `;
}

/** Estas comisiones de la chica, bloqueadas, digan lo que digan (para comprobar que siguen sin pagar). */
export async function lockEarningsById(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  ids: readonly string[],
): Promise<Array<PayableEarningRow & { paid: boolean }>> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<Array<PayableEarningRow & { paid: boolean }>>`
    SELECT id, "commissionCents", "tipCents", "reversedCents", ("payoutId" IS NOT NULL) AS paid
      FROM operator_earnings
     WHERE id = ANY(${[...ids]}::uuid[])
       AND "operatorId" = ${operatorId}::uuid
       AND "tenantId" = ${tenantId}::uuid
     ORDER BY id
     FOR UPDATE
  `;
}

/** Deuda por devoluciones que llegaron con la comisión ya pagada, aún sin descontar, bloqueada. */
export async function lockOpenDebts(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  onlyIds?: readonly string[],
): Promise<OpenDebtRow[]> {
  if (onlyIds && onlyIds.length === 0) return [];
  if (onlyIds) {
    return tx.$queryRaw<OpenDebtRow[]>`
      SELECT r.id, r."reversedDeltaCents"
        FROM earning_reversals r
        JOIN operator_earnings e ON e.id = r."earningId"
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
         AND r."afterPayout"
         AND r."settledPayoutId" IS NULL
         AND r.id = ANY(${[...onlyIds]}::uuid[])
       ORDER BY r.id
       FOR UPDATE OF r
    `;
  }
  return tx.$queryRaw<OpenDebtRow[]>`
    SELECT r.id, r."reversedDeltaCents"
      FROM earning_reversals r
      JOIN operator_earnings e ON e.id = r."earningId"
     WHERE e."operatorId" = ${operatorId}::uuid
       AND e."tenantId" = ${tenantId}::uuid
       AND r."afterPayout"
       AND r."settledPayoutId" IS NULL
     ORDER BY r.id
     FOR UPDATE OF r
  `;
}

/** Lo que entra en un pago: comisiones y deudas, bloqueadas. */
export interface PayoutSelection {
  pending: PayableEarningRow[];
  debts: OpenDebtRow[];
}

/** Lo que fijó una petición de pago aprobada: se paga esto, ni más ni menos. */
export interface ExactPayout {
  earningIds: readonly string[];
  debtIds: readonly string[];
  totalCents: number;
}

/** Código del 409 cuando algo cambió desde que se pidió el pago. */
export const PAYOUT_CHANGED_CODE = 'PAYOUT_CHANGED';

/** Algo cambió desde que se pidió el pago: no se paga (la aprobación queda fallida). */
export function payoutChanged(message: string): ConflictException {
  return new ConflictException({ message, code: PAYOUT_CHANGED_CODE });
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/**
 * Lo pagable ya no es la cifra que vio quien paga (o quien lo pide): 409
 * PAYOUT_CHANGED. Lo usan el pago directo y la petición «Por aprobar».
 */
export function payoutTotalChanged(totalCents: number, expectedTotalCents: number): ConflictException {
  return payoutChanged(
    `Lo que hay que pagar a la chica ha cambiado desde que lo abriste: ahora son ${eur(totalCents)}, no ${eur(expectedTotalCents)}.`,
  );
}

/** Pago de siempre: lo que ya pasó los días de espera del local y toda la deuda abierta. */
export async function payableSelection(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  holdDays: number,
  now: Date = new Date(),
): Promise<PayoutSelection> {
  // Solo earnings con más de N días (los del local o PAYOUT_HOLD_DAYS): el
  // dinero ya está abonado por el banco y una devolución temprana no deja deuda.
  const pending = await lockPayableEarnings(tx, tenantId, operatorId, payoutCutoff(now, holdDays));
  if (pending.length === 0) {
    throw new ConflictException(
      holdDays === 0
        ? 'No hay comisiones pendientes para liquidar.'
        : `No hay comisiones con más de ${holdDays} días para liquidar. Las más recientes siguen en espera.`,
    );
  }
  // Deuda por devoluciones llegadas después de un pago anterior.
  return { pending, debts: await lockOpenDebts(tx, tenantId, operatorId) };
}

/** Pago aprobado: exactamente las comisiones y deudas de la petición, aún sin pagar. */
export async function exactSelection(
  tx: TransactionalClient,
  tenantId: string,
  operatorId: string,
  exact: ExactPayout,
): Promise<PayoutSelection> {
  const rows = await lockEarningsById(tx, tenantId, operatorId, exact.earningIds);
  if (exact.earningIds.length === 0 || rows.length !== exact.earningIds.length || rows.some((r) => r.paid)) {
    throw payoutChanged('Parte de esas comisiones ya se ha pagado desde que se pidió.');
  }
  const debts = await lockOpenDebts(tx, tenantId, operatorId, exact.debtIds);
  if (debts.length !== exact.debtIds.length) {
    throw payoutChanged('La deuda de la chica ya se ha descontado en otro pago desde que se pidió.');
  }
  const pending = rows.map(({ id, commissionCents, tipCents, reversedCents }) => ({
    id,
    commissionCents,
    tipCents,
    reversedCents,
  }));
  return { pending, debts };
}

/** Marca las comisiones y la deuda como liquidadas por este pago. */
export async function settleSelection(
  tx: TransactionalClient,
  payoutId: string,
  pending: readonly PayableEarningRow[],
  debts: readonly OpenDebtRow[],
): Promise<void> {
  const ids = pending.map((e) => e.id);
  await tx.$executeRaw`
    UPDATE operator_earnings
       SET "payoutId" = ${payoutId}::uuid
     WHERE id = ANY(${ids}::uuid[])
  `;
  if (debts.length === 0) return;
  const debtIds = debts.map((d) => d.id);
  await tx.$executeRaw`
    UPDATE earning_reversals
       SET "settledPayoutId" = ${payoutId}::uuid
     WHERE id = ANY(${debtIds}::uuid[])
  `;
}
