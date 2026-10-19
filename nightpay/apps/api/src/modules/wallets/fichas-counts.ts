import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Fichas de una noche del local: las que se dieron, las que volvieron, las
 * perdidas y las que hay en el stock. Por las fechas de cada ficha
 * (wallet_cards no tiene RLS: el local va explícito). Al cerrar la noche se
 * congela en el Z (bloque «fichas»): una ficha que se vuelve a dar otra noche
 * cambia sus fechas, y el Z de la noche anterior no debe cambiar.
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
      COUNT(*) FILTER (WHERE "linkedAt" >= ${window.from} AND "linkedAt" < ${window.to})::int AS entregadas,
      COUNT(*) FILTER (WHERE "returnedAt" >= ${window.from} AND "returnedAt" < ${window.to})::int AS devueltas,
      COUNT(*) FILTER (WHERE "lostAt" >= ${window.from} AND "lostAt" < ${window.to})::int AS perdidas,
      COUNT(*) FILTER (WHERE status = 'RETURNED' OR (status = 'STOCK' AND "stockedAt" IS NOT NULL))::int AS "enStock"
      FROM wallet_cards
     WHERE "venueId" = ${venueId}::uuid
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
