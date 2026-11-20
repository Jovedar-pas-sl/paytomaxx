import { ConflictException } from '@nestjs/common';
import { ALREADY_EXPORTED_CODE, type SepaAlreadyExported } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Los ficheros SEPA para el banco (el del cierre por caseta y el de las
 * transferencias de devolución) quedan en el registro al descargarse. Subir
 * el mismo dos veces al banco paga dos veces: antes de dar otro igual se
 * mira el registro (audit_events, sin tabla nueva) y, si ya se descargó,
 * 409 ALREADY_EXPORTED con cuándo y quién, salvo que se pida otra vez a
 * propósito (`?again=1`, el panel lo confirma antes).
 *
 *  - Cierre: el mismo rango de noches (fromNight y toNight; null y null: la
 *    fiesta entera).
 *  - Devoluciones: alguna de las mismas transferencias (los ids de las
 *    peticiones, en el registro de cada descarga). Descargar no las marca
 *    «Hecha»: una que sigue pendiente sale en el siguiente fichero.
 *
 * La comprobación y el registro van en la misma transacción, con un candado
 * por local y fichero: dos descargas a la vez no pasan las dos.
 */

export const SETTLEMENT_SEPA_ACTION = 'party.settlement.sepa_exported';
export const REFUNDS_SEPA_ACTION = 'party.refunds.sepa_exported';

export interface PreviousExport {
  at: Date;
  actorId: string | null;
  actorEmail: string | null;
}

type Db = Pick<TransactionalClient, '$queryRaw' | 'user'>;

/** Dos descargas del mismo fichero del mismo local, una detrás de otra (hasta el final de la transacción). */
export async function lockSepaExports(tx: Pick<TransactionalClient, '$queryRaw'>, tenantId: string, action: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`party-sepa:${action}:${tenantId}`}))`;
}

/** La última descarga del fichero del cierre con esas mismas noches (null y null: la fiesta entera). */
export async function lastSettlementExport(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  tenantId: string,
  range: { fromNight: string | null; toNight: string | null },
): Promise<PreviousExport | null> {
  const rows = await tx.$queryRaw<PreviousExport[]>`
    SELECT "occurredAt" AS at, "actorId"::text AS "actorId", "actorEmail"
      FROM audit_events
     WHERE "tenantId" = ${tenantId}::uuid
       AND action = ${SETTLEMENT_SEPA_ACTION}
       AND payload->>'fromNight' IS NOT DISTINCT FROM ${range.fromNight}::text
       AND payload->>'toNight' IS NOT DISTINCT FROM ${range.toNight}::text
     ORDER BY "occurredAt" DESC, id DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/** La última descarga del fichero de devoluciones que llevaba alguna de estas transferencias. */
export async function lastRefundsExport(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  tenantId: string,
  requestIds: readonly string[],
): Promise<PreviousExport | null> {
  if (requestIds.length === 0) return null;
  const rows = await tx.$queryRaw<PreviousExport[]>`
    SELECT "occurredAt" AS at, "actorId"::text AS "actorId", "actorEmail"
      FROM audit_events
     WHERE "tenantId" = ${tenantId}::uuid
       AND action = ${REFUNDS_SEPA_ACTION}
       AND jsonb_typeof(payload->'ids') = 'array'
       AND (payload->'ids') ?| ${[...requestIds]}::text[]
     ORDER BY "occurredAt" DESC, id DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/** El 409 ALREADY_EXPORTED: cuándo y quién (su nombre o lo de antes de la @). */
export async function alreadyExported(tx: Db, prev: PreviousExport): Promise<ConflictException> {
  const user = prev.actorId ? await tx.user.findUnique({ where: { id: prev.actorId }, select: { displayName: true, email: true } }) : null;
  const email = user?.email ?? prev.actorEmail ?? '';
  const info: SepaAlreadyExported = {
    exportedAt: prev.at.toISOString(),
    exportedBy: user?.displayName?.trim() || email.split('@')[0] || null,
  };
  return new ConflictException({
    code: ALREADY_EXPORTED_CODE,
    message: 'Este fichero ya se descargó: si lo subes dos veces al banco, pagarás dos veces. Para descargarlo otra vez, confírmalo.',
    ...info,
  });
}
