import { describe, it, expect, vi } from 'vitest';
import { CartaService } from './carta.service';
import { readSnapshot, sortByPopularity, unitsByItem } from './carta-popularity';

const SNAP = (units: Record<string, number>) => ({ computedAt: '2026-11-12T20:00:00.000Z', units });

describe('los más pedidos arriba: cuenta y orden (puro)', () => {
  it('cuenta solo lo pagado, de productos activos, con las unidades de cada línea', () => {
    const units = unitsByItem(['a', 'b', 'c'], [
      { serviceItemId: 'a', qty: 2, paid: true },
      { serviceItemId: 'a', qty: 3, paid: true },
      { serviceItemId: 'b', qty: 9, paid: false },
      { serviceItemId: 'zzz', qty: 5, paid: true },
      { serviceItemId: null, qty: 5, paid: true },
    ]);
    expect(units).toEqual({ a: 5, b: 0, c: 0 });
  });

  it('un pack guarda una línea por parte (mismo cobro y producto): cuenta una vez, no una por parte', () => {
    const units = unitsByItem(['pack', 'copa'], [
      // «1 h con habitación» (dos partes) vendido una vez…
      { serviceItemId: 'pack', qty: 1, paid: true, chargeId: 'p1' },
      { serviceItemId: 'pack', qty: 1, paid: true, chargeId: 'p1' },
      // …y dos veces en otro cobro.
      { serviceItemId: 'pack', qty: 2, paid: true, chargeId: 'p2' },
      { serviceItemId: 'pack', qty: 2, paid: true, chargeId: 'p2' },
      { serviceItemId: 'copa', qty: 3, paid: true, chargeId: 'p2' },
      // Una línea sin cobro cuenta sola.
      { serviceItemId: 'copa', qty: 1, paid: true },
    ]);
    expect(units).toEqual({ pack: 3, copa: 4 });
  });

  it('los más vendidos primero; empates y sin ventas, el orden manual', () => {
    const manual = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const out = sortByPopularity(manual, SNAP({ a: 0, b: 7, c: 7, d: 0 }));
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('un producto nuevo (que no estaba al calcular) va al final', () => {
    const manual = [{ id: 'nuevo' }, { id: 'a' }, { id: 'b' }];
    expect(sortByPopularity(manual, SNAP({ a: 0, b: 3 })).map((r) => r.id)).toEqual(['b', 'a', 'nuevo']);
  });

  it('un JSON raro no vale como snapshot', () => {
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ units: {} })).toBeNull();
    expect(readSnapshot({ computedAt: 'x', units: { a: 'mucho', b: 2 } })).toEqual({ computedAt: 'x', units: { b: 2 } });
  });
});

/** Una noche abierta que guarda su orden, cuatro cerradas con ventas y una quinta que no cuenta. */
function setup() {
  const open = { id: 'n-open', cartaOrder: null as unknown };
  const t = (h: number) => new Date(`2026-11-0${h}T20:00:00Z`);
  const closed = [1, 2, 3, 4].map((h) => ({ openedAt: t(h), closedAt: new Date(t(h).getTime() + 8 * 3600_000) }));
  const items = [
    { id: 'a', name: 'A', category: 'VENUE_BAR', priceCents: 500, components: null, image: null, icon: null },
    { id: 'b', name: 'B', category: 'VENUE_BAR', priceCents: 600, components: null, image: null, icon: null },
    { id: 'c', name: 'C', category: 'VENUE_BAR', priceCents: 700, components: null, image: null, icon: null },
  ];
  let sales = [
    { serviceItemId: 'b', qty: 4, payment: { status: 'AUTHORIZED' }, walletCharge: null },
    { serviceItemId: 'c', qty: 1, payment: null, walletCharge: { status: 'ACCEPTED' } },
    { serviceItemId: 'c', qty: 2, payment: { status: 'FAILED' }, walletCharge: null },
  ];
  const tx = {
    serviceItem: { findMany: vi.fn(async () => items) },
    venueNight: {
      findFirst: vi.fn(async (args: { where: { closedAt: null } }) => (args.where.closedAt === null ? open : null)),
      findMany: vi.fn(async () => closed),
      findUnique: vi.fn(async () => open),
      updateMany: vi.fn(async ({ data }: { data: { cartaOrder: unknown } }) => {
        if (open.cartaOrder !== null) return { count: 0 };
        open.cartaOrder = data.cartaOrder;
        return { count: 1 };
      }),
    },
    paymentLine: { findMany: vi.fn(async () => sales) },
    walletConsumption: { findMany: vi.fn(async () => [] as Array<{ id: string }>) },
    venue: { findUnique: vi.fn().mockResolvedValue({ sections: null }) },
  };
  const prisma = { withTenant: vi.fn(async (_t: string, fn: (x: typeof tx) => unknown) => fn(tx)), venue: tx.venue };
  const service = new CartaService(prisma as never, { log: vi.fn() } as never);
  return { service, tx, open, setSales: (s: typeof sales) => (sales = s) };
}

describe('la carta de la noche (servicio)', () => {
  it('la primera vez calcula con las últimas 4 noches cerradas y lo guarda en la noche', async () => {
    const { service, tx, open } = setup();
    const list = await service.listForStaff('t1', 'WAITER');
    expect(list.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(tx.venueNight.findMany.mock.calls[0]![0]).toMatchObject({ take: 4, orderBy: { openedAt: 'desc' } });
    expect((open.cartaOrder as { units: Record<string, number> }).units).toEqual({ a: 0, b: 4, c: 1 });
  });

  it('no se mueve durante la noche, aunque se vendan más unidades de otro producto', async () => {
    const { service, tx, setSales } = setup();
    const first = (await service.listForStaff('t1', 'WAITER')).map((i) => i.id);
    setSales([{ serviceItemId: 'a', qty: 99, payment: { status: 'AUTHORIZED' }, walletCharge: null }]);
    const second = (await service.listForStaff('t1', 'WAITER')).map((i) => i.id);
    expect(second).toEqual(first);
    // Y ni siquiera vuelve a mirar las ventas.
    expect(tx.paymentLine.findMany).toHaveBeenCalledTimes(1);
    expect(tx.venueNight.updateMany).toHaveBeenCalledTimes(1);
  });

  it('dos peticiones a la vez: gana la primera escritura y las dos ven el mismo orden', async () => {
    const { service } = setup();
    const [x, y] = await Promise.all([service.listForStaff('t1', 'WAITER'), service.listForStaff('t1', 'WAITER')]);
    expect(x.map((i) => i.id)).toEqual(y.map((i) => i.id));
  });

  it('sin noches cerradas: el orden manual, y se guarda igual (nadie vendió nada)', async () => {
    const { service, tx, open } = setup();
    tx.venueNight.findMany.mockResolvedValue([]);
    expect((await service.listForStaff('t1', 'WAITER')).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(tx.paymentLine.findMany).not.toHaveBeenCalled();
    expect((open.cartaOrder as { units: Record<string, number> }).units).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('un pack cuenta una vez por cobro, y un consumo del saldo anulado no cuenta', async () => {
    const { service, tx, open, setSales } = setup();
    setSales([
      // Un pack de dos partes vendido una vez con tarjeta: dos líneas del mismo cobro.
      { serviceItemId: 'a', qty: 1, paymentId: 'p1', walletChargeId: null, payment: { status: 'AUTHORIZED' }, walletCharge: null },
      { serviceItemId: 'a', qty: 1, paymentId: 'p1', walletChargeId: null, payment: { status: 'AUTHORIZED' }, walletCharge: null },
      // Dos copas con el saldo, anuladas después (el dinero volvió al saldo).
      { serviceItemId: 'b', qty: 2, paymentId: null, walletChargeId: 'w1', payment: null, walletCharge: { status: 'ACCEPTED', consumptionId: 'c1' } },
      // Una copa con el saldo que sí se vendió.
      { serviceItemId: 'c', qty: 1, paymentId: null, walletChargeId: 'w2', payment: null, walletCharge: { status: 'ACCEPTED', consumptionId: 'c2' } },
    ] as never);
    tx.walletConsumption.findMany.mockResolvedValue([{ id: 'c1' }]);
    await service.listForStaff('t1', 'WAITER');
    expect((open.cartaOrder as { units: Record<string, number> }).units).toEqual({ a: 1, b: 0, c: 1 });
    // Solo los consumos de esas líneas, del local y anulados.
    expect(tx.walletConsumption.findMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: 't1', id: { in: ['c1', 'c2'] }, reversedAt: { not: null } } });
  });

  it('un producto nuevo a media noche va al final de la lista', async () => {
    const { service, tx } = setup();
    await service.listForStaff('t1', 'WAITER');
    tx.serviceItem.findMany.mockResolvedValue([{ id: 'nuevo', name: 'N', category: 'VENUE_BAR', priceCents: 100, components: null, image: null, icon: null } as never, ...(await tx.serviceItem.findMany())]);
    expect((await service.listForStaff('t1', 'WAITER')).map((i) => i.id)).toEqual(['b', 'c', 'a', 'nuevo']);
  });

  it('el panel (listAll) sigue con el orden manual, sin calcular el orden de la noche', async () => {
    const { service, tx } = setup();
    expect((await service.listAll('t1')).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(tx.venueNight.findMany).not.toHaveBeenCalled(); // solo mira cuándo abrió la noche (para «Agotado»), no calcula el orden
  });
});
