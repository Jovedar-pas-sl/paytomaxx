import { Prisma } from '@nightpay/db';
import type { TransactionalClient } from '../../../common/prisma/prisma.service';
import type { LoadWindowTotals } from './partner-load-rules';

/**
 * SQL crudo de las cargas de los socios (partner_wallet_operations). Siempre
 * con `"tenantId"` y `"connectionId"` explícitos donde la consulta es de una
 * conexión: producción entra como superusuario y RLS no separa nada. Los topes
 * que cruzan locales (todos los socios, todas las conexiones del socio) van
 * aquí y nunca con `tx.partnerWalletOperation.*`: el middleware los limitaría
 * al local de la conexión.
 */

type RawTx = Pick<TransactionalClient, '$queryRaw'>;
const DAY_MS = 86_400_000;
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Lo que ya va cargado (cargas sin anular) en cada ventana de los topes. Con el saldo y la conexión bloqueados. */
export async function loadWindowTotals(
  tx: RawTx,
  a: { connectionId: string; partnerId: string; walletIds: string[]; now: Date; nightStart: Date },
): Promise<LoadWindowTotals> {
  const day = new Date(a.now.getTime() - DAY_MS);
  const month = new Date(a.now.getTime() - 30 * DAY_MS);
  const since = month < a.nightStart ? month : a.nightStart;
  const rows = await tx.$queryRaw<Array<Record<keyof LoadWindowTotals, bigint | number | null>>>`
    SELECT
      COALESCE(SUM(o."amountCents") FILTER (
        WHERE o."connectionId" = ${a.connectionId}::uuid AND o."walletId" = ANY(${a.walletIds}::uuid[]) AND o."createdAt" >= ${day}), 0)::bigint AS "wallet24h",
      COALESCE(SUM(o."amountCents") FILTER (
        WHERE o."walletId" = ANY(${a.walletIds}::uuid[]) AND o."createdAt" >= ${day}), 0)::bigint AS "wallet24hAllPartners",
      COALESCE(SUM(o."amountCents") FILTER (
        WHERE o."walletId" = ANY(${a.walletIds}::uuid[]) AND o."createdAt" >= ${month}
          AND o."connectionId" IN (SELECT c.id FROM partner_connections c WHERE c."partnerId" = ${a.partnerId}::uuid)), 0)::bigint AS "wallet30dPartner",
      COALESCE(SUM(o."amountCents") FILTER (
        WHERE o."connectionId" = ${a.connectionId}::uuid AND o."createdAt" >= ${a.nightStart}), 0)::bigint AS "connectionNight"
      FROM partner_wallet_operations o
     WHERE o.kind = 'LOAD'
       AND o."createdAt" >= ${since}
       AND (o."walletId" = ANY(${a.walletIds}::uuid[]) OR o."connectionId" = ${a.connectionId}::uuid)
       AND NOT EXISTS (SELECT 1 FROM partner_wallet_operations v WHERE v."reversesId" = o.id)
  `;
  const r = rows[0];
  return {
    wallet24h: n(r?.wallet24h),
    wallet24hAllPartners: n(r?.wallet24hAllPartners),
    wallet30dPartner: n(r?.wallet30dPartner),
    connectionNight: n(r?.connectionNight),
  };
}

/** Una carga de la conexión, para leer o enseñar (con su anulación, si la tiene). */
export interface LoadRow {
  id: string;
  walletId: string;
  amountCents: number;
  balanceAfterCents: number;
  funding: string;
  description: string;
  reference: string | null;
  device: string | null;
  cashTopupId: string | null;
  requestHash: string;
  response: unknown;
  createdAt: Date;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

const LOAD_COLUMNS = Prisma.sql`
  o.id::text AS id, o."walletId"::text AS "walletId", o."amountCents", o."balanceAfterCents", o.funding, o.description,
  o.reference, o.device, o."cashTopupId"::text AS "cashTopupId", o."requestHash", o.response, o."createdAt",
  v."createdAt" AS "voidedAt", v."voidedByUserId"::text AS "voidedByUserId", v.reason AS "voidReason"`;

const voidJoin = (tenantId: string) =>
  Prisma.sql`LEFT JOIN partner_wallet_operations v ON v."reversesId" = o.id AND v."tenantId" = ${tenantId}::uuid AND v.kind = 'LOAD_VOID'`;

/** La carga con esa clave en esta conexión (repetirla o 422 idempotency_key_reused). */
export async function loadByKey(tx: RawTx, a: { tenantId: string; connectionId: string; idempotencyKey: string }): Promise<LoadRow | null> {
  const rows = await tx.$queryRaw<LoadRow[]>`
    SELECT ${LOAD_COLUMNS}
      FROM partner_wallet_operations o ${voidJoin(a.tenantId)}
     WHERE o."tenantId" = ${a.tenantId}::uuid AND o."connectionId" = ${a.connectionId}::uuid
       AND o.kind = 'LOAD' AND o."idempotencyKey" = ${a.idempotencyKey}
  `;
  return rows[0] ?? null;
}

/** Una carga de esta conexión por su id (de otra conexión o un LOAD_VOID: null). */
export async function loadById(tx: RawTx, a: { tenantId: string; connectionId: string; id: string }): Promise<LoadRow | null> {
  const rows = await tx.$queryRaw<LoadRow[]>`
    SELECT ${LOAD_COLUMNS}
      FROM partner_wallet_operations o ${voidJoin(a.tenantId)}
     WHERE o.id = ${a.id}::uuid AND o."tenantId" = ${a.tenantId}::uuid AND o."connectionId" = ${a.connectionId}::uuid AND o.kind = 'LOAD'
  `;
  return rows[0] ?? null;
}

/**
 * La carga, bloqueada para anularla. Producción entra como superusuario: solo
 * este WHERE (la conexión, su local y LOAD) separa las cargas de cada conexión.
 */
export async function lockLoad(tx: RawTx, a: { tenantId: string; connectionId: string; id: string }): Promise<LoadRow | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM partner_wallet_operations
     WHERE id = ${a.id}::uuid AND "connectionId" = ${a.connectionId}::uuid AND "tenantId" = ${a.tenantId}::uuid AND kind = 'LOAD'
     FOR UPDATE
  `;
  if (locked.length === 0) return null;
  return loadById(tx, a);
}

/** Una página de cargas de la conexión en [from, to), de la más antigua a la más nueva (`createdAt`, `id`). */
export async function listLoads(
  tx: RawTx,
  a: { tenantId: string; connectionId: string; from: Date; to: Date; reference: string | null; after: { createdAt: Date; id: string } | null; take: number },
): Promise<LoadRow[]> {
  const ref = a.reference === null ? Prisma.empty : Prisma.sql`AND o.reference = ${a.reference}`;
  const after = a.after === null ? Prisma.empty : Prisma.sql`AND (o."createdAt", o.id) > (${a.after.createdAt}, ${a.after.id}::uuid)`;
  return tx.$queryRaw<LoadRow[]>`
    SELECT ${LOAD_COLUMNS}
      FROM partner_wallet_operations o ${voidJoin(a.tenantId)}
     WHERE o."tenantId" = ${a.tenantId}::uuid AND o."connectionId" = ${a.connectionId}::uuid AND o.kind = 'LOAD'
       AND o."createdAt" >= ${a.from} AND o."createdAt" < ${a.to} ${ref} ${after}
     ORDER BY o."createdAt", o.id
     LIMIT ${a.take}
  `;
}

export interface StatementTotals {
  byFunding: Record<'cash' | 'card' | 'transfer' | 'bank_app', { count: number; amount: number }>;
  voids: { count: number; amount: number };
}

/**
 * El resumen de una conexión en [from, to): las cargas a su hora y las
 * anulaciones a la suya (también las del local, desde su panel).
 */
export async function partnerStatementSql(tx: RawTx, a: { tenantId: string; connectionId: string; from: Date; to: Date }): Promise<StatementTotals> {
  const rows = await tx.$queryRaw<Array<{ kind: string; funding: string | null; count: bigint | number; amount: bigint | number }>>`
    SELECT o.kind::text AS kind, o.funding, COUNT(*)::bigint AS count, COALESCE(SUM(o."amountCents"), 0)::bigint AS amount
      FROM partner_wallet_operations o
     WHERE o."tenantId" = ${a.tenantId}::uuid AND o."connectionId" = ${a.connectionId}::uuid
       AND o."createdAt" >= ${a.from} AND o."createdAt" < ${a.to}
     GROUP BY o.kind, o.funding
  `;
  const zero = () => ({ count: 0, amount: 0 });
  const out: StatementTotals = { byFunding: { cash: zero(), card: zero(), transfer: zero(), bank_app: zero() }, voids: zero() };
  for (const r of rows) {
    const slot = r.kind === 'LOAD_VOID' ? out.voids : out.byFunding[r.funding as keyof StatementTotals['byFunding']];
    if (!slot) continue;
    slot.count += n(r.count);
    slot.amount += n(r.amount);
  }
  return out;
}

// ─── Lo que mira la vigilancia (tras responder, sin candados) ───────────

/** Cargas nuevas de la conexión desde `since` (la ráfaga: más de 30 en un minuto). */
export async function loadsSince(tx: RawTx, a: { tenantId: string; connectionId: string; since: Date }): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*)::bigint AS count FROM partner_wallet_operations
     WHERE "tenantId" = ${a.tenantId}::uuid AND "connectionId" = ${a.connectionId}::uuid AND kind = 'LOAD' AND "createdAt" >= ${a.since}
  `;
  return n(rows[0]?.count);
}

/** Anulaciones hechas por la plataforma (por la API, sin persona del panel) desde `since`. */
export async function apiVoidsSince(tx: RawTx, a: { tenantId: string; connectionId: string; since: Date }): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*)::bigint AS count FROM partner_wallet_operations
     WHERE "tenantId" = ${a.tenantId}::uuid AND "connectionId" = ${a.connectionId}::uuid AND kind = 'LOAD_VOID'
       AND "voidedByUserId" IS NULL AND "createdAt" >= ${a.since}
  `;
  return n(rows[0]?.count);
}

/** El efectivo de un cajero (`device`; sin él, todas las cargas sin cajero juntas) en saldos distintos desde `since`. */
export async function deviceCashSince(
  tx: RawTx,
  a: { tenantId: string; connectionId: string; device: string | null; since: Date },
): Promise<{ wallets: number; total: number }> {
  const who = a.device === null ? Prisma.sql`o.device IS NULL` : Prisma.sql`o.device = ${a.device}`;
  const rows = await tx.$queryRaw<Array<{ wallets: bigint | number; total: bigint | number }>>`
    SELECT COUNT(DISTINCT o."walletId")::bigint AS wallets, COALESCE(SUM(o."amountCents"), 0)::bigint AS total
      FROM partner_wallet_operations o
     WHERE o."tenantId" = ${a.tenantId}::uuid AND o."connectionId" = ${a.connectionId}::uuid AND o.kind = 'LOAD'
       AND o.funding = 'cash' AND o."createdAt" >= ${a.since} AND ${who}
       AND NOT EXISTS (SELECT 1 FROM partner_wallet_operations v WHERE v."reversesId" = o.id)
  `;
  return { wallets: n(rows[0]?.wallets), total: n(rows[0]?.total) };
}
