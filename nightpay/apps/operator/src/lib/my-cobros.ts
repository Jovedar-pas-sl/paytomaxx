import type { OwnCobro, OwnCobrosPage } from '@nightpay/contracts';
import { authedFetch } from './api';

export async function fetchOwnCobros(cursor?: string, signal?: AbortSignal): Promise<OwnCobrosPage> {
  const q = new URLSearchParams({ limit: '50' });
  if (cursor) q.set('cursor', cursor);
  const res = await authedFetch(`/v1/staff/me/cobros?${q}`, { signal });
  if (!res.ok) throw new Error('No se pudo cargar tu historial de cobros. Vuelve a intentarlo.');
  return res.json();
}

/** Conserva páginas anteriores y actualiza los estados que ya estaban visibles. */
export function mergeOwnCobros(previous: readonly OwnCobro[], fresh: readonly OwnCobro[]): OwnCobro[] {
  const items = new Map(previous.map((r) => [`${r.kind}:${r.id}`, r]));
  for (const row of fresh) items.set(`${row.kind}:${row.id}`, row);
  return [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/**
 * Un refresco: lo que ha vuelto a llegar manda, y una fila de ese tramo que ya
 * no viene se quita (p. ej. el cobro con tarjeta que canceló el saldo al
 * pagarlo con la ficha: su fila es la del saldo, creada justo después). De
 * lo cargado antes solo se queda lo más antiguo que lo refrescado, y nada si
 * el refresco llegó al final del historial (), como mergeLatestPage
 * del panel.
 */
export function mergeRefreshed(previous: readonly OwnCobro[], fresh: readonly OwnCobro[], complete: boolean): OwnCobro[] {
  const sorted = mergeOwnCobros([], fresh);
  const edge = sorted.at(-1);
  if (!edge || complete) return sorted;
  const older = previous.filter((r) => r.createdAt < edge.createdAt || (r.createdAt === edge.createdAt && r.id < edge.id));
  return mergeOwnCobros(older, sorted);
}

export type OwnNight = NonNullable<OwnCobrosPage['night']>;

export interface OwnCobrosSnapshot {
  items: OwnCobro[] | null;
  cursor: string | null;
  error: string | null;
  moreBusy: boolean;
  /** La noche del local (de la primera página): desde dónde cuenta «Esta noche». */
  night: OwnNight | null;
}
type LoadPage = (cursor?: string, signal?: AbortSignal) => Promise<OwnCobrosPage>;

/** Tope de páginas en un refresco (50 cada una): si se pasa, el total de la noche se dice incompleto. */
export const MAX_REFRESH_PAGES = 20;

/** Una página que llega a la fila `edge` (o más atrás). */
const reaches = (items: readonly OwnCobro[], edge: { createdAt: string; id: string }) =>
  items.some((r) => r.createdAt < edge.createdAt || (r.createdAt === edge.createdAt && r.id <= edge.id));

/**
 * Serializa el sondeo y la paginación; publica cada recorrido completo, nunca
 * una página parcial. El refresco vuelve a pedir todo lo cargado (hasta el
 * cobro visible más antiguo) y, como mínimo, hasta el principio de la noche:
 * una devolución de una fila antigua se ve y el total de la noche está entero.
 */
export function createOwnCobrosFeed(load: LoadPage, publish: (state: OwnCobrosSnapshot) => void) {
  let state: OwnCobrosSnapshot = { items: null, cursor: null, error: null, moreBusy: false, night: null };
  let tail = Promise.resolve(false);
  let disposed = false;
  let active: AbortController | null = null;
  let moreQueued = false;
  const update = (patch: Partial<OwnCobrosSnapshot>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    publish(state);
  };

  function enqueue(more: boolean, signal?: AbortSignal): Promise<boolean> {
    const work = tail.then(async () => {
      if (disposed || signal?.aborted) return false;
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (more && !state.cursor) return true;
        const oldest = state.items?.at(-1);
        let night = state.night;
        let cursor = more ? state.cursor ?? undefined : undefined;
        let fresh: OwnCobro[] = [];
        const visited = new Set<string>();
        let nextCursor: string | null;
        let pages = 0;
        do {
          const page = await load(cursor, controller.signal);
          if (controller.signal.aborted || disposed) return false;
          if (!cursor && page.night !== undefined) night = page.night;
          fresh = mergeOwnCobros(fresh, page.items);
          nextCursor = page.nextCursor;
          pages++;
          // La frontera es una fila, no el número de páginas: las altas pueden desplazarla.
          const reachedOldest = !oldest || reaches(page.items, oldest);
          const reachedNight = !night || page.items.some((r) => r.createdAt < night!.from);
          if (more || (reachedOldest && reachedNight) || !nextCursor || pages >= MAX_REFRESH_PAGES) break;
          if (visited.has(nextCursor)) throw new Error('No se pudo avanzar en el historial. Vuelve a intentarlo.');
          visited.add(nextCursor);
          cursor = nextCursor;
        } while (cursor);
        const items = more ? mergeOwnCobros(state.items ?? [], fresh) : mergeRefreshed(state.items ?? [], fresh, nextCursor === null);
        update({ items, cursor: nextCursor, error: null, night });
        return true;
      } catch (err) {
        if (!controller.signal.aborted && !disposed) update({ error: (err as Error).message });
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = null;
      }
    });
    tail = work;
    return work;
  }

  return {
    snapshot: () => state,
    refresh: (signal?: AbortSignal) => enqueue(false, signal),
    loadMore: async () => {
      if (disposed || moreQueued) return false;
      moreQueued = true;
      update({ moreBusy: true });
      try { return await enqueue(true); }
      finally { moreQueued = false; update({ moreBusy: false }); }
    },
    dispose: () => { disposed = true; active?.abort(); },
  };
}

// ─── De un vistazo: estado, propina y total de la noche ─────────────────

export type OwnCobroTone = 'ok' | 'wait' | 'bad' | 'void';
export type OwnCobroIcon = 'check' | 'clock' | 'x' | 'back';

const STATE: Readonly<Record<string, { label: string; tone: OwnCobroTone; icon: OwnCobroIcon }>> = {
  AUTHORIZED: { label: 'Cobrado', tone: 'ok', icon: 'check' },
  ACCEPTED: { label: 'Cobrado', tone: 'ok', icon: 'check' },
  CREATED: { label: 'Pendiente', tone: 'wait', icon: 'clock' },
  AWAITING_CAPTURE: { label: 'Pendiente', tone: 'wait', icon: 'clock' },
  AUTHORIZING: { label: 'Pagando', tone: 'wait', icon: 'clock' },
  ORPHAN: { label: 'Sin confirmar', tone: 'wait', icon: 'clock' },
  PARTIALLY_REFUNDED: { label: 'Devuelto en parte', tone: 'void', icon: 'back' },
  REFUNDED: { label: 'Devuelto', tone: 'void', icon: 'back' },
  REVERSED: { label: 'Anulado', tone: 'void', icon: 'x' },
  CANCELED: { label: 'Cancelado', tone: 'void', icon: 'x' },
  EXPIRED: { label: 'Caducado', tone: 'void', icon: 'x' },
  FAILED: { label: 'Fallido', tone: 'bad', icon: 'x' },
  DECLINED: { label: 'Rechazado', tone: 'bad', icon: 'x' },
};

/** La palabra, el color y el icono del chip de cada estado (se lee de lejos, a oscuras). */
export function ownCobroState(status: string): { label: string; tone: OwnCobroTone; icon: OwnCobroIcon } {
  return STATE[status] ?? { label: status, tone: 'void', icon: 'clock' };
}

export const ownCobroStatus = (status: string): string => ownCobroState(status).label;

const CHARGED = new Set(['AUTHORIZED', 'ACCEPTED', 'PARTIALLY_REFUNDED']);
const PENDING = new Set(['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN']);

/** Lo que queda cobrado de una fila (importe + propina − lo devuelto); 0 si no se cobró. */
export function ownChargedCents(row: Pick<OwnCobro, 'status' | 'amountCents' | 'tipCents' | 'refundedCents'>): number {
  if (!CHARGED.has(row.status)) return 0;
  return Math.max(0, row.amountCents + row.tipCents - (row.refundedCents ?? 0));
}

export interface OwnNightTotals {
  /** Ventas cobradas de la noche (con propinas, sin lo devuelto; sin recargas). */
  salesCents: number;
  count: number;
  tipCents: number;
  /** Recargas de saldo cobradas: no son venta. */
  topUpCents: number;
  topUpCount: number;
  pending: number;
  /** Las filas cargadas llegan al principio de la noche (o al final del historial). */
  complete: boolean;
}

/** «Esta noche» con lo cargado; `complete` dice si lo cargado llega al principio de la noche. */
export function ownNightTotals(items: readonly OwnCobro[], night: OwnNight, cursor: string | null): OwnNightTotals {
  const totals: OwnNightTotals = { salesCents: 0, count: 0, tipCents: 0, topUpCents: 0, topUpCount: 0, pending: 0, complete: false };
  for (const r of items) {
    if (r.createdAt < night.from) continue;
    if (PENDING.has(r.status)) totals.pending++;
    const charged = ownChargedCents(r);
    if (!CHARGED.has(r.status)) continue;
    if (r.isTopUp) {
      totals.topUpCents += charged;
      totals.topUpCount++;
    } else {
      totals.salesCents += charged;
      totals.count++;
      totals.tipCents += r.tipCents;
    }
  }
  totals.complete = cursor === null || items.some((r) => r.createdAt < night.from);
  return totals;
}
