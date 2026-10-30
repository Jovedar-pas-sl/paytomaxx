import { Prisma } from '@nightpay/db';
import { BANK_HOLD_RELEASED_EVENT, POS_UNPROVEN_EVENT_TYPES } from '@nightpay/contracts';

/**
 * «Pendiente de cuadrar con el banco» (H-1), en SQL: la misma regla en todos
 * los sitios que calculan lo que se paga al personal (createPayout, «Por
 * aprobar», el saldo de la chica y su vista previa, Tesorería, el cierre de
 * la noche, el mapa del dinero y la consola). Ver @nightpay/contracts/bank-hold.
 *
 * Un cobro está retenido si:
 *  - tiene un evento de venta por datáfono sin prueba del banco
 *    (`pos.confirmed`: lo tecleó un camarero; `pos.device_unproven`: el PAX
 *    sin la consulta de Paytef),
 *  - el cuadre con el banco no lo tiene casado (bank_statement_items MATCHED
 *    sin `supersededAt`: si un fichero posterior lo sustituye y ya no casa,
 *    vuelve a retenerse) y
 *  - el dueño no lo ha liberado (`pos.bank_released`).
 *
 * Se calcula al momento (no se guarda): casar el fichero del banco lo libera
 * solo, sin ningún trabajo aparte. payment_events y bank_statement_items no
 * tienen FORCE RLS y llevan el local del cobro: valen dentro de withTenant y
 * de asSystem.
 */

const ALIAS = /^[a-z_][a-z0-9_]*$/i;

function alias(name: string): string {
  if (!ALIAS.test(name)) throw new Error(`bank-hold-sql: alias no válido «${name}»`);
  return name;
}

const UNPROVEN_SQL = POS_UNPROVEN_EVENT_TYPES.map((t) => `'${t}'`).join(', ');

/** El cobro de esta columna (`e."paymentId"`, `p.id`…) está retenido. Sin parámetros: se puede repetir en una consulta. */
function heldFor(paymentRef: string): Prisma.Sql {
  return Prisma.raw(`(EXISTS (SELECT 1 FROM payment_events bh_u
                  WHERE bh_u."paymentId" = ${paymentRef} AND bh_u."eventType" IN (${UNPROVEN_SQL}))
     AND NOT EXISTS (SELECT 1 FROM bank_statement_items bh_m
                      WHERE bh_m."paymentId" = ${paymentRef} AND bh_m.status = 'MATCHED' AND bh_m."supersededAt" IS NULL)
     AND NOT EXISTS (SELECT 1 FROM payment_events bh_r
                      WHERE bh_r."paymentId" = ${paymentRef} AND bh_r."eventType" = '${BANK_HOLD_RELEASED_EVENT}'))`);
}

/** La ganancia (alias de operator_earnings) es de un cobro retenido. Las del saldo (consumptionId) nunca. */
export function earningBankHeldSql(earningAlias: string): Prisma.Sql {
  const ref = `${alias(earningAlias)}."paymentId"`;
  return Prisma.sql`(${Prisma.raw(ref)} IS NOT NULL AND ${heldFor(ref)})`;
}

/** El cobro (alias de payments) está retenido. */
export function paymentBankHeldSql(paymentAlias: string): Prisma.Sql {
  return heldFor(`${alias(paymentAlias)}.id`);
}

/** Lo que una ganancia deja a cobrar (comisión + propina − devuelto). `e` = alias de operator_earnings. */
export function earningNetSql(earningAlias: string): Prisma.Sql {
  const e = alias(earningAlias);
  return Prisma.raw(`(${e}."commissionCents" + COALESCE(${e}."tipCents", 0) - ${e}."reversedCents")`);
}

/** Ventas por datáfono retenidas de un local más antiguas que `before` (el aviso diario de Telegram). */
export interface StaleBankHolds {
  /** Cuántas ventas. */
  count: number;
  /** Lo cobrado en el datáfono en esas ventas. */
  chargedCents: number;
  /** La parte del personal que está retenida. */
  shareCents: number;
  /** La más antigua (null si no hay). */
  oldestAt: Date | null;
}

/**
 * Lo retenido de un local con más de 24 h (o lo que diga `before`): las
 * ventas con algo que pagar al personal (las devueltas enteras no cuentan).
 * operator_earnings tiene FORCE RLS: va con el bypass (asSystem), con el local
 * explícito en el SQL.
 */
export async function staleBankHolds(
  tx: { $queryRaw: <T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T> },
  tenantId: string,
  before: Date,
): Promise<StaleBankHolds> {
  const rows = await tx.$queryRaw<Array<{ count: number; chargedCents: bigint | null; shareCents: bigint | null; oldestAt: Date | null }>>`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(s.charged), 0)::bigint AS "chargedCents",
           COALESCE(SUM(s.share), 0)::bigint AS "shareCents", MIN(s.at) AS "oldestAt"
      FROM (
        SELECT p.id, (p."amountCents" + p."serviceFeeCents" + p."tipCents") AS charged,
               SUM(${earningNetSql('e')}) AS share, COALESCE(p."authorizedAt", p."createdAt") AS at
          FROM operator_earnings e
          JOIN payments p ON p.id = e."paymentId"
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."payoutId" IS NULL
           AND COALESCE(p."authorizedAt", p."createdAt") < ${before}
           AND ${earningBankHeldSql('e')}
         GROUP BY p.id
        HAVING SUM(${earningNetSql('e')}) > 0
      ) s
  `;
  const r = rows[0];
  return {
    count: Number(r?.count ?? 0),
    chargedCents: Number(r?.chargedCents ?? 0),
    shareCents: Number(r?.shareCents ?? 0),
    oldestAt: r?.oldestAt ?? null,
  };
}
