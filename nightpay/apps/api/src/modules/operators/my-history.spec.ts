import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../money-map/cobros-rows';
import { historyOrder, historyPage, historyRange, historyWhere } from './my-history';

// El historial de «Ganancias» de la app (sus ganancias y sus pagos): por
// páginas y entre dos fechas. Sin base: el SQL que sale y la página.

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const ID_3 = '33333333-3333-4333-8333-333333333333';

describe('historyRange', () => {
  it('sin nada: desde el principio, sin fechas', () => {
    expect(historyRange({})).toEqual({ from: null, to: null, cursor: null });
  });

  it('las fechas y el cursor de la página anterior', () => {
    const cursor = encodeCursor({ createdAt: '2026-11-10T22:15:00.123Z', id: ID_2 });
    expect(historyRange({ from: '2026-11-01T07:00:00.000Z', to: '2026-11-16T07:00:00+00:00', cursor })).toEqual({
      from: new Date('2026-11-01T07:00:00.000Z'),
      to: new Date('2026-11-16T07:00:00.000Z'),
      cursor: { at: new Date('2026-11-10T22:15:00.123Z'), id: ID_2 },
    });
  });

  it('un cursor que no es de la lista: la primera página (como en «Cobros»)', () => {
    expect(historyRange({ cursor: 'basura' }).cursor).toBeNull();
  });
});

describe('historyWhere y historyOrder', () => {
  it('sin fechas ni cursor: nada que añadir', () => {
    const sql = historyWhere('e', { from: null, to: null, cursor: null });
    expect(sql.text.trim()).toBe('');
    expect(sql.values).toEqual([]);
  });

  it('las fechas [desde, hasta) y la página: por milisegundo y, a la misma hora, por id (como el orden)', () => {
    const from = new Date('2026-11-01T07:00:00.000Z');
    const to = new Date('2026-11-16T07:00:00.000Z');
    const at = new Date('2026-11-10T22:15:00.123Z');
    const sql = historyWhere('po', { from, to, cursor: { at, id: ID_2 } });
    expect(sql.text).toContain('po."createdAt" >= $1');
    expect(sql.text).toContain('po."createdAt" < $2');
    expect(sql.text).toContain(`(date_trunc('milliseconds', po."createdAt"), po.id) < ($3::timestamptz, $4::uuid)`);
    expect(sql.values).toEqual([from, to, at, ID_2]);
    expect(historyOrder('po').text).toBe(`date_trunc('milliseconds', po."createdAt") DESC, po.id DESC`);
  });
});

describe('historyPage', () => {
  const rows = [
    { id: ID_3, createdAt: '2026-11-12T01:00:00.000Z' },
    { id: ID_2, createdAt: '2026-11-11T01:00:00.000Z' },
    { id: ID_1, createdAt: '2026-11-10T01:00:00.000Z' },
  ];

  it('una fila de más: hay otra página, que empieza después de la última enseñada', () => {
    const page = historyPage(rows, 2);
    expect(page.items.map((r) => r.id)).toEqual([ID_3, ID_2]);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ at: new Date('2026-11-11T01:00:00.000Z'), id: ID_2 });
  });

  it('las que caben: no hay más', () => {
    expect(historyPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(historyPage([], 50)).toEqual({ items: [], nextCursor: null });
  });
});
