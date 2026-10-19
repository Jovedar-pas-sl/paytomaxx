import { Prisma } from '@nightpay/db';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * En el stock (alias c): devueltas y grabadas sin dar (también las ACTIVE sin
 * saldo del API anterior, paso 1 de 2 de 20261021100000, si se grabaron).
 */
export const IN_STOCK_SQL = Prisma.sql`(c.status = 'RETURNED'
  OR (c.status IN ('STOCK', 'ACTIVE') AND c."walletId" IS NULL AND c."stockedAt" IS NOT NULL))`;

/**
 * Fichas de una noche del local: las que se dieron, las que volvieron y las
 * perdidas (o sustituidas), por los eventos de cada ficha con el local de ese
 * momento (wallet_card_events): una ficha dada, devuelta y dada otra vez
 * cuenta dos entregas, y la noche de un local no cambia si la ficha pasa luego
 * a otro del grupo. Y las que hay ahora en el stock (la fila de cada ficha).
 * Sin RLS: el local va explícito. Al cerrar la noche se congela en el Z
 * (bloque «fichas»).
 */
export interface FichasCounts {
  entregadas: number;
  devueltas: number;
  perdidas: number;
  /** En el stock del local en este momento (STOCK grabadas + RETURNED). */
  enStock: number;
}

export async function fichasCounts(
  db: Pick<PrismaService, '$queryRaw'>,
  venueId: string,
  window: { from: Date; to: Date },
): Promise<FichasCounts> {
  const rows = await db.$queryRaw<Array<{ entregadas: number; devueltas: number; perdidas: number; enStock: number }>>`
    SELECT
      (SELECT COUNT(*) FILTER (WHERE e.kind = 'ISSUED')::int FROM wallet_card_events e
        WHERE e."venueId" = ${venueId}::uuid AND e."at" >= ${window.from} AND e."at" < ${window.to}) AS entregadas,
      (SELECT COUNT(*) FILTER (WHERE e.kind = 'RETURNED')::int FROM wallet_card_events e
        WHERE e."venueId" = ${venueId}::uuid AND e."at" >= ${window.from} AND e."at" < ${window.to}) AS devueltas,
      (SELECT COUNT(*) FILTER (WHERE e.kind = 'LOST')::int FROM wallet_card_events e
        WHERE e."venueId" = ${venueId}::uuid AND e."at" >= ${window.from} AND e."at" < ${window.to}) AS perdidas,
      (SELECT COUNT(*)::int FROM wallet_cards c
        WHERE c."venueId" = ${venueId}::uuid AND ${IN_STOCK_SQL}) AS "enStock"
  `;
  const r = rows[0];
  return {
    entregadas: Number(r?.entregadas ?? 0),
    devueltas: Number(r?.devueltas ?? 0),
    perdidas: Number(r?.perdidas ?? 0),
    enStock: Number(r?.enStock ?? 0),
  };
}

/** Las fichas congeladas en un Z (null si el Z es de antes de las fichas o no es válido). */
export function frozenFichas(z: unknown): FichasCounts | null {
  const f = z && typeof z === 'object' ? (z as { fichas?: unknown }).fichas : null;
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  const n = (k: string): number | null => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null);
  const entregadas = n('entregadas');
  const devueltas = n('devueltas');
  const perdidas = n('perdidas');
  const enStock = n('enStock');
  if (entregadas === null || devueltas === null || perdidas === null || enStock === null) return null;
  return { entregadas, devueltas, perdidas, enStock };
}
