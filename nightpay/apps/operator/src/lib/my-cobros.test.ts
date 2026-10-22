import { expect, it, vi } from 'vitest';
import type { OwnCobro, OwnCobrosPage } from '@nightpay/contracts';
import { createOwnCobrosFeed, mergeOwnCobros, ownCobroStatus } from './my-cobros';
const row = (id: string, kind: OwnCobro['kind'], createdAt: string, status = 'AUTHORIZED'): OwnCobro => ({ id, kind, createdAt, status, ref: null, amountCents: 2000, tipCents: 0, methodLabel: kind === 'SALDO' ? 'Saldo' : 'Tarjeta', service: 'Invitar a una copa', via: null, isTopUp: false, invitedName: 'Lola' });
it('actualiza estados sin duplicar páginas y conserva cobros de ambos canales', () => {
  const previous = [row('a', 'PAYMENT', '2026-10-21T20:00:00Z', 'CREATED'), row('older', 'SALDO', '2026-10-20T20:00:00Z')];
  const merged = mergeOwnCobros(previous, [row('a', 'PAYMENT', '2026-10-21T20:00:00Z'), row('a', 'SALDO', '2026-10-21T21:00:00Z', 'ACCEPTED')]);
  expect(merged).toHaveLength(3);
  expect(merged[0]!.kind).toBe('SALDO');
  expect(merged[1]!.status).toBe('AUTHORIZED');
  expect(merged[2]!.id).toBe('older');
  expect(ownCobroStatus('ACCEPTED')).toBe('Cobrado');
  expect(ownCobroStatus('REVERSED')).toBe('Anulado');
});

const historyRow = (n: number, status = 'AUTHORIZED') => row(String(n).padStart(4, '0'), 'PAYMENT', new Date(Date.UTC(2026, 9, 21, 0, n)).toISOString(), status);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('revalida hasta el cobro visible más antiguo aunque las altas nuevas desplacen varias páginas', async () => {
  let rows = Array.from({ length: 150 }, (_, n) => historyRow(150 - n));
  const load = vi.fn(async (cursor?: string): Promise<OwnCobrosPage> => {
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    const items = rows.slice(start, start + 50);
    return { items, nextCursor: start + 50 < rows.length ? items.at(-1)!.id : null };
  });
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh(); await feed.loadMore(); await feed.loadMore();
  rows = [...Array.from({ length: 70 }, (_, n) => historyRow(220 - n)), ...rows.map((r) => r.id === '0001' ? { ...r, status: 'REFUNDED' } : r)];
  load.mockClear();
  await feed.refresh();
  expect(load).toHaveBeenCalledTimes(5);
  expect(feed.snapshot().items?.find((r) => r.id === '0001')?.status).toBe('REFUNDED');
  expect(feed.snapshot().items).toHaveLength(220);
  expect(feed.snapshot().cursor).toBeNull();
});

it('serializa Ver anteriores con el refresco y usa el cursor actualizado sin duplicar', async () => {
  const pending = deferred<OwnCobrosPage>();
  const load = vi.fn().mockResolvedValueOnce({ items: [historyRow(3)], nextCursor: 'old' })
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce({ items: [historyRow(2)], nextCursor: 'last' });
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh();
  const refresh = feed.refresh(); const more = feed.loadMore();
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2);
  pending.resolve({ items: [historyRow(4), historyRow(3)], nextCursor: 'fresh' });
  await Promise.all([refresh, more]);
  expect(load.mock.calls[2]?.[0]).toBe('fresh');
  expect(feed.snapshot().items?.map((r) => r.id)).toEqual(['0004', '0003', '0002']);
});

it('desmontar aborta la petición y no publica una respuesta tardía', async () => {
  const pending = deferred<OwnCobrosPage>();
  const publish = vi.fn(); let signal: AbortSignal | undefined;
  const feed = createOwnCobrosFeed(async (_cursor, nextSignal) => { signal = nextSignal; return pending.promise; }, publish);
  const work = feed.refresh(); await Promise.resolve();
  feed.dispose(); publish.mockClear();
  pending.resolve({ items: [historyRow(1)], nextCursor: null });
  await work;
  expect(signal?.aborted).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});

it('un fallo de la segunda página conserva el historial y el cursor completos para reintentar', async () => {
  const load = vi.fn().mockResolvedValueOnce({ items: [historyRow(2)], nextCursor: 'more' })
    .mockResolvedValueOnce({ items: [historyRow(1)], nextCursor: null })
    .mockResolvedValueOnce({ items: [historyRow(3), historyRow(2)], nextCursor: 'more' })
    .mockRejectedValueOnce(new Error('Sin conexión'));
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh(); await feed.loadMore();
  expect(await feed.refresh()).toBe(false);
  expect(feed.snapshot()).toMatchObject({ cursor: null, error: 'Sin conexión' });
  expect(feed.snapshot().items?.map((r) => r.id)).toEqual(['0002', '0001']);
});
