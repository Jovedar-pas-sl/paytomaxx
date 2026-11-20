import { Prisma } from '@nightpay/db';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { PAID_STATUSES_SQL, cashTopUpCount, paymentAt, refundAt } from '../reports/reporting-sql';
import type { CardTopUpRow, CashPayoutRow, CashTopUpRow, StallHourRow, StallMeta } from './party-live-rules';

/**
 * Las consultas del panel de OxioParty (en directo, la caja de la taquilla y
 * la liquidación por caseta). Siempre dentro de withTenant (wallet_cash_topups,
 * stalls y payment_lines tienen FORCE RLS) y con el local explícito en el
 * SQL, como reporting-sql.ts: las mismas fechas y filtros que el Z y el mapa
 * del dinero (cobros pagados por su momento, devoluciones hechas por el día
 * del banco, consumos no anulados por cuándo se hicieron).
 */

export interface SqlWindow {
  /** null: desde el principio. */
  from: Date | null;
  to: Date;
}

type Num = number | bigint | null;
const n = (v: Num | undefined): number => Number(v ?? 0);

/** `AND <col> >= from AND <col> < to` (sin from, solo el final). */
function inWindow(col: Prisma.Sql, w: SqlWindow): Prisma.Sql {
  return w.from ? Prisma.sql`AND ${col} >= ${w.from} AND ${col} < ${w.to}` : Prisma.sql`AND ${col} < ${w.to}`;
}

/**
 * Lo vendido por caseta y hora: los cobros pagados que no son recargas y
 * los consumos del saldo no anulados (con su propina, sin la «Comisión del
 * servicio») y, en negativo, lo devuelto de esos cobros (sin la comisión
 * devuelta), cada cosa en su momento. Un cobro único se paga una sola vez
 * (con tarjeta, o con el saldo y entonces cuenta su consumo): no se cuenta dos veces.
 */
export async function stallSalesByHour(tx: TransactionalClient, tenantId: string, w: SqlWindow, now: Date): Promise<StallHourRow[]> {
  const lastHourFrom = new Date(now.getTime() - 3_600_000);
  const rows = await tx.$queryRaw<
    Array<{ stallId: string | null; hour: Num; cents: Num; count: Num; lastAt: Date | null; refunded: Num; lastHour: Num }>
  >`
    WITH ventas AS (
      SELECT p."stallId" AS "stallId", (p."amountCents" + p."tipCents")::bigint AS cents, ${paymentAt('p')} AS at, 1 AS n, 0::bigint AS refunded
        FROM payments p
       WHERE p."tenantId" = ${tenantId}::uuid AND p.status IN ${PAID_STATUSES_SQL} AND p."walletId" IS NULL
             ${inWindow(paymentAt('p'), w)}
      UNION ALL
      SELECT c."stallId", (c."amountCents" + c."tipCents")::bigint, c."createdAt", 1, 0::bigint
        FROM wallet_consumptions c
       WHERE c."tenantId" = ${tenantId}::uuid AND c."reversedAt" IS NULL
             ${inWindow(Prisma.sql`c."createdAt"`, w)}
      UNION ALL
      SELECT p."stallId", -(r."amountCents" - r."serviceFeeCents")::bigint, ${refundAt('r')}, 0, (r."amountCents" - r."serviceFeeCents")::bigint
        FROM refunds r
        JOIN payments p ON p.id = r."paymentId"
       WHERE r."tenantId" = ${tenantId}::uuid AND r.status = 'SUCCEEDED' AND p."walletId" IS NULL
             ${inWindow(refundAt('r'), w)}
    )
    SELECT v."stallId",
           FLOOR(EXTRACT(EPOCH FROM v.at) / 3600)::bigint AS hour,
           COALESCE(SUM(v.cents), 0)::bigint AS cents,
           COALESCE(SUM(v.n), 0)::int AS count,
           MAX(v.at) FILTER (WHERE v.n = 1) AS "lastAt",
           COALESCE(SUM(v.refunded), 0)::bigint AS refunded,
           COALESCE(SUM(v.cents) FILTER (WHERE v.at >= ${lastHourFrom}), 0)::bigint AS "lastHour"
      FROM ventas v
     GROUP BY 1, 2
  `;
  return rows.map((r) => ({
    stallId: r.stallId,
    hour: n(r.hour),
    cents: n(r.cents),
    count: n(r.count),
    lastAt: r.lastAt,
    refundedCents: n(r.refunded),
    lastHourCents: n(r.lastHour),
  }));
}

/** Del datáfono de recepción: una venta suya confirmada (Paytef) o con su clave de recepción. */
const RECEPTION_DEVICE = Prisma.sql`(p."posOperationNumber" IS NOT NULL OR p."idempotencyKey" LIKE 'reception:%')`;

/**
 * Recargas con tarjeta pagadas, por quién las cobró: una persona (la
 * taquilla), el datáfono de recepción, o el propio asistente desde su móvil
 * (el enlace del local, «Recargar» en su saldo): sin persona ni datáfono.
 */
export async function cardTopUps(tx: TransactionalClient, tenantId: string, w: SqlWindow, now: Date): Promise<CardTopUpRow[]> {
  const lastHourFrom = new Date(now.getTime() - 3_600_000);
  const rows = await tx.$queryRaw<Array<{ kind: CardTopUpRow['kind']; who: string | null; cents: Num; count: Num; lastHour: Num }>>`
    SELECT CASE WHEN p."createdByUserId" IS NOT NULL THEN 'person'
                WHEN ${RECEPTION_DEVICE} THEN 'terminal'
                ELSE 'phone' END AS kind,
           CASE WHEN p."createdByUserId" IS NOT NULL THEN p."createdByUserId"::text
                WHEN ${RECEPTION_DEVICE} THEN p."terminalId"::text
                ELSE NULL END AS who,
           COALESCE(SUM(p."amountCents" + p."tipCents"), 0)::bigint AS cents,
           COUNT(*)::int AS count,
           COALESCE(SUM(p."amountCents" + p."tipCents") FILTER (WHERE ${paymentAt('p')} >= ${lastHourFrom}), 0)::bigint AS "lastHour"
      FROM payments p
     WHERE p."tenantId" = ${tenantId}::uuid AND p.status IN ${PAID_STATUSES_SQL} AND p."walletId" IS NOT NULL
           ${inWindow(paymentAt('p'), w)}
     GROUP BY 1, 2
  `;
  return rows.map((r) => ({ kind: r.kind, who: r.who, cents: n(r.cents), count: n(r.count), lastHourCents: n(r.lastHour) }));
}

/** Recargas en efectivo por quién las cobró (persona o datáfono de recepción); las anulaciones restan. */
export async function cashTopUps(
  tx: TransactionalClient,
  tenantId: string,
  w: SqlWindow,
  now: Date,
  onlyUserId?: string,
): Promise<CashTopUpRow[]> {
  const lastHourFrom = new Date(now.getTime() - 3_600_000);
  const who = onlyUserId ? Prisma.sql`AND ct."takenByUserId" = ${onlyUserId}::uuid` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ kind: CashTopUpRow['kind']; who: string; cents: Num; fee: Num; count: Num; lastHour: Num }>>`
    SELECT CASE WHEN ct."takenByUserId" IS NOT NULL THEN 'person' ELSE 'terminal' END AS kind,
           COALESCE(ct."takenByUserId", ct."terminalId")::text AS who,
           COALESCE(SUM(ct."amountCents"), 0)::bigint AS cents,
           COALESCE(SUM(ct."serviceFeeCents"), 0)::bigint AS fee,
           ${cashTopUpCount('ct')}::int AS count,
           COALESCE(SUM(ct."amountCents") FILTER (WHERE ct."createdAt" >= ${lastHourFrom}), 0)::bigint AS "lastHour"
      FROM wallet_cash_topups ct
     WHERE ct."tenantId" = ${tenantId}::uuid ${who}
           ${inWindow(Prisma.sql`ct."createdAt"`, w)}
     GROUP BY 1, 2
  `;
  return rows.map((r) => ({ kind: r.kind, who: r.who, cents: n(r.cents), feeCents: n(r.fee), count: n(r.count), lastHourCents: n(r.lastHour) }));
}

/** Saldo devuelto en efectivo (hecho) por quien lo dio. */
export async function cashPayouts(tx: TransactionalClient, tenantId: string, w: SqlWindow, onlyUserId?: string): Promise<CashPayoutRow[]> {
  const who = onlyUserId ? Prisma.sql`AND wp."paidByUserId" = ${onlyUserId}::uuid` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ who: string; cents: Num; count: Num }>>`
    SELECT wp."paidByUserId"::text AS who, COALESCE(SUM(wp."amountCents"), 0)::bigint AS cents, COUNT(*)::int AS count
      FROM wallet_payouts wp
     WHERE wp."tenantId" = ${tenantId}::uuid AND wp.status = 'DONE' AND wp.method = 'CASH' ${who}
           ${inWindow(Prisma.sql`wp."createdAt"`, w)}
     GROUP BY 1
  `;
  return rows.map((r) => ({ who: r.who, cents: n(r.cents), count: n(r.count) }));
}

/** Saldo devuelto (hecho, en efectivo y a la tarjeta) en la ventana. */
export async function walletPayoutsTotal(tx: TransactionalClient, tenantId: string, w: SqlWindow): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ cents: Num }>>`
    SELECT COALESCE(SUM(wp."amountCents"), 0)::bigint AS cents
      FROM wallet_payouts wp
     WHERE wp."tenantId" = ${tenantId}::uuid AND wp.status = 'DONE'
           ${inWindow(Prisma.sql`wp."createdAt"`, w)}
  `;
  return n(row?.cents);
}

/**
 * El dinero que aún hay en las pulseras (saldos activos, ahora) y cuántas
 * están activas: con saldo o que ya han pagado algo (una recarga con tarjeta
 * que no se llegó a pagar deja un saldo vacío sin consumos: no cuenta).
 */
export async function wristbandsNow(tx: TransactionalClient, tenantId: string): Promise<{ balanceCents: number; active: number }> {
  const [row] = await tx.$queryRaw<Array<{ cents: Num; active: Num }>>`
    SELECT COALESCE(SUM(w."balanceCents"), 0)::bigint AS cents,
           COUNT(*) FILTER (
             WHERE w."balanceCents" > 0
                OR EXISTS (SELECT 1 FROM wallet_consumptions c WHERE c."walletId" = w.id AND c."tenantId" = ${tenantId}::uuid)
           )::int AS active
      FROM client_wallets w
     WHERE w."tenantId" = ${tenantId}::uuid AND w.status = 'ACTIVE' AND w."mergedIntoId" IS NULL
  `;
  return { balanceCents: n(row?.cents), active: n(row?.active) };
}

/** Las casetas del local (todas: también las desactivadas, por si vendieron). */
export async function stallMeta(tx: TransactionalClient, tenantId: string): Promise<StallMeta[]> {
  return tx.stall.findMany({
    where: { tenantId },
    select: { id: true, name: true, managerName: true, managerContact: true, organizerBps: true, active: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/** Los nombres de las personas (el suyo o su correo) y de los datáfonos de las taquillas. */
export async function deskNames(
  tx: TransactionalClient,
  tenantId: string,
  ids: { people: readonly string[]; terminals: readonly string[] },
): Promise<{ people: Map<string, string>; terminals: Map<string, string> }> {
  const [people, terminals] = await Promise.all([
    ids.people.length
      ? tx.user.findMany({ where: { tenantId, id: { in: [...ids.people] } }, select: { id: true, displayName: true, email: true } })
      : Promise.resolve([]),
    ids.terminals.length
      ? tx.terminal.findMany({ where: { tenantId, id: { in: [...ids.terminals] } }, select: { id: true, label: true } })
      : Promise.resolve([]),
  ]);
  return {
    people: new Map(people.map((p) => [p.id, p.displayName?.trim() || p.email])),
    terminals: new Map(terminals.map((t) => [t.id, t.label])),
  };
}
