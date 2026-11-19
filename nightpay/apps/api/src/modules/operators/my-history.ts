/**
 * El historial de «Ganancias» de la app (sus ganancias y sus pagos): por
 * páginas y, si se quiere, entre dos instantes [desde, hasta). El cursor es
 * el de «Cobros» (fecha e id de la última fila enseñada).
 */
import { Prisma } from '@nightpay/db';
import type { OwnHistoryPage, OwnHistoryQuery } from '@nightpay/contracts';
import { decodeCursor, encodeCursor, type FeedCursor } from '../money-map/cobros-rows';

export interface HistoryRange {
  from: Date | null;
  to: Date | null;
  /** La última fila de la página anterior (null: la primera página). */
  cursor: FeedCursor | null;
}

export const NO_HISTORY_RANGE: HistoryRange = { from: null, to: null, cursor: null };

/** Un cursor que no es de la lista da la primera página (como en «Cobros»). */
export function historyRange(q: Pick<OwnHistoryQuery, 'cursor' | 'from' | 'to'>): HistoryRange {
  return { from: q.from ? new Date(q.from) : null, to: q.to ? new Date(q.to) : null, cursor: decodeCursor(q.cursor) };
}

// La base guarda microsegundos y el cursor lleva milisegundos: orden y página
// por milisegundo y, a la misma hora, por id; así ninguna fila se salta ni se repite.
const atMs = (alias: string) => Prisma.raw(`date_trunc('milliseconds', ${alias}."createdAt")`);

/** Lo que se añade al WHERE (`alias` es el de la tabla en la consulta, nunca algo de fuera). */
export function historyWhere(alias: string, r: HistoryRange): Prisma.Sql {
  const created = Prisma.raw(`${alias}."createdAt"`);
  return Prisma.sql`${r.from ? Prisma.sql`AND ${created} >= ${r.from}` : Prisma.empty}
         ${r.to ? Prisma.sql`AND ${created} < ${r.to}` : Prisma.empty}
         ${r.cursor ? Prisma.sql`AND (${atMs(alias)}, ${Prisma.raw(`${alias}.id`)}) < (${r.cursor.at}::timestamptz, ${r.cursor.id}::uuid)` : Prisma.empty}`;
}

/** El ORDER BY que encaja con la página de historyWhere: la más reciente primero. */
export function historyOrder(alias: string): Prisma.Sql {
  return Prisma.sql`${atMs(alias)} DESC, ${Prisma.raw(`${alias}.id`)} DESC`;
}

/** Con `limit` + 1 filas pedidas: la página y, si sobró una, el cursor de la siguiente. */
export function historyPage<T extends { id: string; createdAt: string }>(rows: T[], limit: number): OwnHistoryPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
