import { describe, expect, it, vi } from 'vitest';
import type { OwnCobro, OwnCobrosPage } from '@nightpay/contracts';
import {
  createOwnCobrosFeed,
  MAX_REFRESH_PAGES,
  mergeOwnCobros,
  ownChargedCents,
  ownCobroState,
  ownCobroStatus,
  ownNightTotals,
} from './my-cobros';

const row = (id: string, kind: OwnCobro['kind'], createdAt: string, status = 'AUTHORIZED'): OwnCobro => ({ id, kind, createdAt, status, ref: null, amountCents: 2000, tipCents: 0, methodLabel: kind === 'SALDO' ? 'Saldo' : 'Tarjeta', service: 'Invitar a una copa', via: null, isTopUp: false, invitedName: 'Lola', refundedCents: 0 });
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
/** Un API de mentira: páginas de 50 sobre `rows` (más nuevas primero), con la noche en la primera. */
function pagedApi(get: () => OwnCobro[], night?: OwnCobrosPage['night']) {
  return vi.fn(async (cursor?: string): Promise<OwnCobrosPage> => {
    const rows = get();
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    const items = rows.slice(start, start + 50);
    return { items, nextCursor: start + 50 < rows.length ? items.at(-1)!.id : null, ...(cursor || night === undefined ? {} : { night }) };
  });
}

it('revalida hasta el cobro visible más antiguo aunque las altas nuevas desplacen varias páginas', async () => {
  let rows = Array.from({ length: 150 }, (_, n) => historyRow(150 - n));
  const load = pagedApi(() => rows);
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh(); await feed.loadMore(); await feed.loadMore();
  rows = [...Array.from({ length: 70 }, (_, n) => historyRow(220 - n)), ...rows.map((r) => r.id === '0001' ? { ...r, status: 'REFUNDED', refundedCents: 2000 } : r)];
  load.mockClear();
  await feed.refresh();
  expect(load).toHaveBeenCalledTimes(5);
  expect(feed.snapshot().items?.find((r) => r.id === '0001')?.status).toBe('REFUNDED');
  expect(feed.snapshot().items).toHaveLength(220);
  expect(new Set(feed.snapshot().items?.map((r) => r.id)).size).toBe(220);
  expect(feed.snapshot().cursor).toBeNull();
});

it('con más de 50 cobros en la noche, el primer refresco carga hasta el principio de la noche y una anulación antigua cambia el total', async () => {
  // 120 cobros esta noche (desde el minuto 30) y 30 de antes.
  let rows = Array.from({ length: 150 }, (_, n) => historyRow(150 - n));
  const night = { from: historyRow(31).createdAt, open: true };
  const load = pagedApi(() => rows, night);
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh();
  expect(load).toHaveBeenCalledTimes(3);
  const first = feed.snapshot();
  expect(first.night).toEqual(night);
  expect(ownNightTotals(first.items!, night, first.cursor)).toMatchObject({ salesCents: 120 * 2000, count: 120, complete: true });
  // El cliente de la fila 40 (de la segunda página) recibe una devolución.
  rows = rows.map((r) => (r.id === '0040' ? { ...r, status: 'REFUNDED', refundedCents: 2000 } : r));
  await feed.refresh();
  const after = feed.snapshot();
  expect(after.items?.find((r) => r.id === '0040')?.status).toBe('REFUNDED');
  expect(new Set(after.items?.map((r) => r.id)).size).toBe(after.items?.length);
  expect(ownNightTotals(after.items!, night, after.cursor)).toMatchObject({ salesCents: 119 * 2000, count: 119 });
});

it('un refresco no pasa del tope de páginas: el total de la noche se dice incompleto', async () => {
  const rows = Array.from({ length: 50 * (MAX_REFRESH_PAGES + 2) }, (_, n) => row(`r${String(n).padStart(5, '0')}`, 'PAYMENT', new Date(Date.UTC(2026, 9, 21, 22) - n * 1000).toISOString()));
  const night = { from: '2026-10-20T00:00:00.000Z', open: true };
  const load = vi.fn(async (cursor?: string): Promise<OwnCobrosPage> => {
    const start = cursor ? Number(cursor) : 0;
    return { items: rows.slice(start, start + 50), nextCursor: String(start + 50), ...(cursor ? {} : { night }) };
  });
  const feed = createOwnCobrosFeed(load, () => undefined);
  await feed.refresh();
  expect(load).toHaveBeenCalledTimes(MAX_REFRESH_PAGES);
  const s = feed.snapshot();
  expect(ownNightTotals(s.items!, night, s.cursor).complete).toBe(false);
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

describe('de un vistazo, a oscuras', () => {
  it('cada estado con su color y su icono: cobrado verde, pendiente ámbar, fallido rojo, anulado o devuelto gris', () => {
    expect(ownCobroState('AUTHORIZED')).toEqual({ label: 'Cobrado', tone: 'ok', icon: 'check' });
    expect(ownCobroState('ACCEPTED')).toEqual({ label: 'Cobrado', tone: 'ok', icon: 'check' });
    expect(ownCobroState('CREATED')).toEqual({ label: 'Pendiente', tone: 'wait', icon: 'clock' });
    expect(ownCobroState('AUTHORIZING')).toMatchObject({ tone: 'wait' });
    expect(ownCobroState('FAILED')).toEqual({ label: 'Fallido', tone: 'bad', icon: 'x' });
    expect(ownCobroState('DECLINED')).toMatchObject({ tone: 'bad' });
    expect(ownCobroState('REVERSED')).toEqual({ label: 'Anulado', tone: 'void', icon: 'x' });
    expect(ownCobroState('REFUNDED')).toEqual({ label: 'Devuelto', tone: 'void', icon: 'back' });
    expect(ownCobroState('ALGO_NUEVO')).toMatchObject({ label: 'ALGO_NUEVO', tone: 'void' });
  });

  it('el total de la noche: ventas con propina, sin lo devuelto, sin recargas (no son venta) y sin lo de antes', () => {
    const night = { from: '2026-10-21T20:00:00.000Z', open: true };
    const at = (min: number) => new Date(Date.UTC(2026, 9, 21, 20, min)).toISOString();
    const items: OwnCobro[] = [
      { ...row('tip', 'PAYMENT', at(50)), amountCents: 2000, tipCents: 500, service: '2 copas' },
      { ...row('part', 'PAYMENT', at(40), 'PARTIALLY_REFUNDED'), amountCents: 3000, refundedCents: 1000 },
      { ...row('nfc', 'SALDO', at(35), 'ACCEPTED'), amountCents: 1000 },
      { ...row('topup', 'PAYMENT', at(30)), amountCents: 10000, isTopUp: true, service: null },
      { ...row('wait', 'PAYMENT', at(20), 'CREATED') },
      { ...row('void', 'SALDO', at(15), 'REVERSED') },
      { ...row('fail', 'PAYMENT', at(10), 'FAILED') },
      { ...row('ayer', 'PAYMENT', '2026-10-20T23:00:00.000Z'), amountCents: 9900 },
    ];
    expect(ownNightTotals(items, night, 'más')).toEqual({
      salesCents: 2500 + 2000 + 1000, count: 3, tipCents: 500, topUpCents: 10000, topUpCount: 1, pending: 1, complete: true,
    });
    expect(ownChargedCents(items[1]!)).toBe(2000);
    expect(ownChargedCents(items[5]!)).toBe(0);
    // Sin llegar al principio de la noche (y con más por cargar), el total no está entero.
    expect(ownNightTotals(items.slice(0, 3), night, 'más').complete).toBe(false);
    expect(ownNightTotals(items.slice(0, 3), night, null).complete).toBe(true);
  });
});
