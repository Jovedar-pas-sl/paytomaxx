import { describe, expect, it, vi } from 'vitest';
import type { OwnCobro, OwnCobrosPage } from '@nightpay/contracts';
import {
  createOwnCobrosFeed,
  MAX_REFRESH_PAGES,
  mergeOwnCobros,
  mergeRefreshed,
  ownChargedCents,
  ownCobroCancelable,
  ownCobroState,
  ownCobroStatus,
  ownNightTotals,
  ownPaidTwiceNote,
  ownCobrosPollMs,
} from './my-cobros';

const row = (id: string, kind: OwnCobro['kind'], createdAt: string, status = 'AUTHORIZED'): OwnCobro => ({ id, kind, createdAt, status, ref: null, amountCents: 2000, tipCents: 0, methodLabel: kind === 'SALDO' ? 'Saldo' : 'Tarjeta', service: 'Copa con invitación', via: null, isTopUp: false, invitedName: 'Lola', refundedCents: 0 });
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

describe('una fila que deja de venir se quita al refrescar', () => {
  it('cobro único pagado con la ficha: la fila «Pendiente» del cobro con tarjeta da paso a la del saldo', async () => {
    const night = { from: '2026-10-21T19:00:00Z', open: true };
    const card = { ...row('card-1', 'PAYMENT', '2026-10-21T20:00:00.000Z', 'CREATED'), ref: 'C-0007' };
    const saldo = { ...row('saldo-1', 'SALDO', '2026-10-21T20:00:00.100Z', 'ACCEPTED'), ref: 'C-0007' };
    let rows: OwnCobro[] = [card];
    const feed = createOwnCobrosFeed(pagedApi(() => rows, night), () => undefined);
    await feed.refresh();
    expect(ownNightTotals(feed.snapshot().items!, night, null).pending).toBe(1);
    // El API ya no enseña el cobro con tarjeta que canceló el saldo: solo el del saldo.
    rows = [saldo];
    await feed.refresh();
    expect(feed.snapshot().items!.map((r) => `${r.kind} ${r.status}`)).toEqual(['SALDO ACCEPTED']);
    const totals = ownNightTotals(feed.snapshot().items!, night, feed.snapshot().cursor);
    expect(totals).toMatchObject({ pending: 0, count: 1, salesCents: 2000 });
  });

  it('con «Ver anteriores» cargado, una fila que deja de venir en medio se quita y el resto sigue', async () => {
    let rows = Array.from({ length: 80 }, (_, n) => historyRow(80 - n));
    const feed = createOwnCobrosFeed(pagedApi(() => rows), () => undefined);
    await feed.refresh();
    await feed.loadMore();
    expect(feed.snapshot().items).toHaveLength(80);
    // Desaparece una fila de la parte nueva (la 0070): se quita; las demás siguen.
    rows = rows.filter((r) => r.id !== '0070');
    await feed.refresh();
    const ids = feed.snapshot().items!.map((r) => r.id);
    expect(ids).toHaveLength(79);
    expect(ids).not.toContain('0070');
    expect(ids.at(-1)).toBe('0001');
  });
});

it('refresco sin llegar al final (tope de páginas): lo más antiguo que lo refrescado se queda; lo del tramo que no vuelve, no', () => {
  const previous = [historyRow(5), historyRow(4), historyRow(3), historyRow(2), historyRow(1)];
  const fresh = [historyRow(6), historyRow(5), historyRow(3)];
  expect(mergeRefreshed(previous, fresh, false).map((r) => r.id)).toEqual(['0006', '0005', '0003', '0002', '0001']);
  expect(mergeRefreshed(previous, fresh, true).map((r) => r.id)).toEqual(['0006', '0005', '0003']);
  expect(mergeRefreshed(previous, [], true)).toEqual([]);
});

describe('lo que la chica tenía en su lista de antes, y el «cobrado dos veces» del panel', () => {
  const at = '2026-10-21T22:00:00.000Z';
  it('se cancela un cobro con tarjeta sin pagar (esperando el datáfono o con el cliente en su banco); pagado, cerrado o del saldo, no', () => {
    expect(ownCobroCancelable(row('a', 'PAYMENT', at, 'CREATED'))).toBe(true);
    expect(ownCobroCancelable(row('b', 'PAYMENT', at, 'AWAITING_CAPTURE'))).toBe(true);
    expect(ownCobroCancelable(row('e', 'PAYMENT', at, 'AUTHORIZING'))).toBe(true);
    for (const status of ['AUTHORIZED', 'CANCELED', 'EXPIRED', 'FAILED', 'REFUNDED']) {
      expect(ownCobroCancelable(row('c', 'PAYMENT', at, status))).toBe(false);
    }
    expect(ownCobroCancelable(row('d', 'SALDO', at, 'ACCEPTED'))).toBe(false);
  });

  it('cobrado dos veces (el saldo y después la tarjeta): la fila de la tarjeta lo dice, como en el panel', () => {
    const eur = (cents: number) => `${cents / 100} €`;
    const card = row('t', 'PAYMENT', at, 'CANCELED');
    expect(ownPaidTwiceNote({ ...card, paidTwice: { amountCents: 12_000, refunded: true } }, eur)).toBe(
      'Cobrado dos veces: la tarjeta se devolvió sola (120 €)',
    );
    expect(ownPaidTwiceNote({ ...card, paidTwice: { amountCents: 12_000, refunded: false } }, eur)).toBe(
      'Cobrado dos veces: hay que devolver 120 € a la tarjeta (avisa al encargado: está en Incidencias)',
    );
    expect(ownPaidTwiceNote({ ...card, paidTwice: null }, eur)).toBeNull();
    // Un API de antes no trae el campo: nada que decir.
    expect(ownPaidTwiceNote(card, eur)).toBeNull();
  });
});

describe('cada cuánto se refresca «Cobros»', () => {
  const chica = { cancelPending: true, pollMs: 5000 };
  const resto = { cancelPending: false, pollMs: 15_000 };
  it('la chica: cada 5 s solo mientras tenga un cobro con tarjeta esperando; si no, cada 15 s', () => {
    expect(ownCobrosPollMs(chica, [{ kind: 'PAYMENT', status: 'CREATED' }, { kind: 'SALDO', status: 'ACCEPTED' }])).toBe(5000);
    expect(ownCobrosPollMs(chica, [{ kind: 'PAYMENT', status: 'AUTHORIZED' }, { kind: 'SALDO', status: 'ACCEPTED' }])).toBe(15_000);
    expect(ownCobrosPollMs(chica, null)).toBe(15_000);
  });
  it('el resto del personal, como siempre', () => {
    expect(ownCobrosPollMs(resto, [{ kind: 'PAYMENT', status: 'CREATED' }])).toBe(15_000);
  });
});
