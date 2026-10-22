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

export interface OwnCobrosSnapshot {
  items: OwnCobro[] | null;
  cursor: string | null;
  error: string | null;
  moreBusy: boolean;
}
type LoadPage = (cursor?: string, signal?: AbortSignal) => Promise<OwnCobrosPage>;

/** Serializa el sondeo y la paginación; publica cada recorrido completo, nunca una página parcial. */
export function createOwnCobrosFeed(load: LoadPage, publish: (state: OwnCobrosSnapshot) => void) {
  let state: OwnCobrosSnapshot = { items: null, cursor: null, error: null, moreBusy: false };
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
        let cursor = more ? state.cursor ?? undefined : undefined;
        let fresh: OwnCobro[] = [];
        const visited = new Set<string>();
        let nextCursor: string | null;
        do {
          const page = await load(cursor, controller.signal);
          if (controller.signal.aborted || disposed) return false;
          fresh = mergeOwnCobros(fresh, page.items);
          nextCursor = page.nextCursor;
          // La frontera es una fila, no el número de páginas: las altas pueden desplazarla.
          const reached = !oldest || page.items.some((r) =>
            r.createdAt < oldest.createdAt || (r.createdAt === oldest.createdAt && r.id <= oldest.id));
          if (more || reached || !nextCursor) break;
          if (visited.has(nextCursor)) throw new Error('No se pudo avanzar en el historial. Vuelve a intentarlo.');
          visited.add(nextCursor);
          cursor = nextCursor;
        } while (cursor);
        update({ items: mergeOwnCobros(state.items ?? [], fresh), cursor: nextCursor, error: null });
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

const STATUS: Readonly<Record<string, string>> = {
  CREATED: 'Pendiente', AWAITING_CAPTURE: 'Pendiente', AUTHORIZING: 'Pagando', AUTHORIZED: 'Cobrado', ACCEPTED: 'Cobrado',
  PARTIALLY_REFUNDED: 'Devuelto parcialmente', REFUNDED: 'Devuelto', REVERSED: 'Anulado', CANCELED: 'Cancelado',
  EXPIRED: 'Caducado', FAILED: 'Fallido', DECLINED: 'Rechazado',
};
export const ownCobroStatus = (status: string): string => STATUS[status] ?? status;
