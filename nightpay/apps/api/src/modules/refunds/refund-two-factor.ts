import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { eur } from '../../common/money/eur';

/** Desde este importe devuelto (acumulado) se pide el código 2FA. */
export const TWO_FA_THRESHOLD_CENTS = 100_00; // 100 €

/** Ventana del acumulado por persona (devoluciones en cobros distintos). */
export const TWO_FA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Lo que una persona ya ha devuelto por la pasarela (pendiente o hecho). */
export interface RefundTotals {
  /** En este mismo cobro (cualquier fecha). */
  samePaymentCents: number;
  /** En cualquier cobro, en las últimas 24 h. */
  lastDayCents: number;
}

/**
 * El 2FA no se decide por petición (99,99 € × N lo esquivaba) sino por lo
 * devuelto acumulado por la misma persona: en el mismo cobro y en 24 h.
 * Devuelve null si no hace falta; si hace falta, el motivo para enseñarlo.
 */
export function twoFactorReason(amountCents: number, totals: RefundTotals): string | null {
  const samePayment = totals.samePaymentCents + amountCents;
  if (samePayment >= TWO_FA_THRESHOLD_CENTS) return `en este cobro sumas ${eur(samePayment)}`;
  const lastDay = totals.lastDayCents + amountCents;
  if (lastDay >= TWO_FA_THRESHOLD_CENTS) return `en las últimas 24 h sumas ${eur(lastDay)}`;
  return null;
}

/**
 * Lo devuelto por la persona: solo devoluciones por la pasarela (las del
 * banco ya las hizo el dueño en su portal) que estén pendientes o hechas.
 */
export async function refundTotalsOf(
  tx: TransactionalClient,
  who: { userId: string; tenantId: string },
  paymentId: string,
  now: Date = new Date(),
): Promise<RefundTotals> {
  const base = {
    tenantId: who.tenantId,
    requestedBy: who.userId,
    registeredManually: false,
    status: { in: ['PENDING' as const, 'SUCCEEDED' as const] },
  };
  const [samePayment, lastDay] = await Promise.all([
    tx.refund.aggregate({ where: { ...base, paymentId }, _sum: { amountCents: true } }),
    tx.refund.aggregate({
      where: { ...base, createdAt: { gte: new Date(now.getTime() - TWO_FA_WINDOW_MS) } },
      _sum: { amountCents: true },
    }),
  ]);
  return {
    samePaymentCents: samePayment._sum.amountCents ?? 0,
    lastDayCents: lastDay._sum.amountCents ?? 0,
  };
}

/**
 * Candado por persona (hasta el final de la transacción): dos devoluciones
 * suyas a la vez no pueden pasar las dos por debajo del umbral. Se toma
 * SIEMPRE antes que la fila del cobro (mismo orden en todas → sin interbloqueos).
 */
export async function lockRefundsOf(tx: TransactionalClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`refund-user:${userId}`}))`;
}
