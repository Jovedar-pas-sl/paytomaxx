import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CartaService } from '../../src/modules/carta/carta.service';

// «Los más pedidos arriba», fijo cada noche, con PostgreSQL y un rol sin superusuario.

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const service = new CartaService(prisma, { log: async () => undefined } as never);
const venues: string[] = [];
beforeAll(async () => { await prisma.onModuleInit(); });
afterAll(async () => {
  await prisma.asSystem(async (tx) => {
    await tx.paymentLine.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.payment.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.terminal.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.venueNight.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.serviceItem.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.venue.deleteMany({ where: { id: { in: venues } } });
  });
  await prisma.onApplicationShutdown();
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 9, 1, 20);

async function setup() {
  const id = (await prisma.asSystem((tx) => tx.venue.create({ data: { name: 'Orden de la noche', slug: `orden-${randomUUID()}` } }))).id;
  venues.push(id);
  return prisma.withTenant(id, async (tx) => {
    const terminal = await tx.terminal.create({ data: { tenantId: id, externalId: randomUUID(), label: 'Orden test' } });
    const mk = (name: string, sortOrder: number, priceCents = 1000) =>
      tx.serviceItem.create({ data: { tenantId: id, name, category: 'VENUE_BAR', priceCents, sortOrder } });
    const [a, b, c, d] = [await mk('A', 1), await mk('B', 2), await mk('C', 3), await mk('D', 4)];
    return { id, terminal, a: a, b: b, c: c, d: d };
  });
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Una noche (n = 0 la más antigua) cerrada, con su fila de venta. */
async function closedNight(ctx: Ctx, n: number) {
  await prisma.withTenant(ctx.id, (tx) =>
    tx.venueNight.create({ data: { tenantId: ctx.id, openedAt: new Date(BASE + n * DAY), closedAt: new Date(BASE + n * DAY + 8 * HOUR) } }),
  );
}
async function sell(ctx: Ctx, itemId: string, qty: number, night: number, status = 'AUTHORIZED') {
  await prisma.withTenant(ctx.id, async (tx) => {
    const at = new Date(BASE + night * DAY + HOUR);
    const payment = await tx.payment.create({ data: {
      tenantId: ctx.id, terminalId: ctx.terminal.id, idempotencyKey: randomUUID(), amountCents: 1000 * qty,
      availableAmountCents: 1000 * qty, qrToken: randomUUID(), qrExpiresAt: new Date(Date.now() + 60_000), status, createdAt: at,
    } });
    await tx.paymentLine.create({ data: {
      tenantId: ctx.id, paymentId: payment.id, serviceItemId: itemId, category: 'VENUE_BAR', label: 'x', qty,
      unitCents: 1000, amountCents: 1000 * qty, createdAt: at,
    } });
  });
}
async function openNight(ctx: Ctx) {
  return prisma.withTenant(ctx.id, (tx) => tx.venueNight.create({ data: { tenantId: ctx.id, openedAt: new Date(BASE + 10 * DAY) } }));
}
const names = async (ctx: Ctx, role = 'OWNER') => (await service.listForStaff(ctx.id, role)).map((i) => i.name);

describe('carta ordenada por lo más pedido, fija cada noche', () => {
  it('cuenta las últimas 4 noches cerradas (la quinta no), solo lo pagado, y guarda el orden en la noche', async () => {
    const ctx = await setup();
    for (let n = 0; n < 5; n++) await closedNight(ctx, n);
    await sell(ctx, ctx.d.id, 50, 0); // la noche más antigua: fuera de las 4
    await sell(ctx, ctx.c.id, 5, 2);
    await sell(ctx, ctx.b.id, 2, 3);
    await sell(ctx, ctx.b.id, 1, 4);
    await sell(ctx, ctx.a.id, 40, 4, 'FAILED'); // sin pagar: no cuenta
    const night = await openNight(ctx);
    expect(await names(ctx)).toEqual(['C', 'B', 'A', 'D']);
    const saved = await prisma.withTenant(ctx.id, (tx) => tx.venueNight.findUnique({ where: { id: night.id } }));
    expect(saved?.cartaOrder).toMatchObject({ units: { [ctx.a.id]: 0, [ctx.b.id]: 3, [ctx.c.id]: 5, [ctx.d.id]: 0 } });
  });

  it('no se mueve en toda la noche, ni con ventas nuevas ni con un producto nuevo (que va al final)', async () => {
    const ctx = await setup();
    await closedNight(ctx, 3);
    await sell(ctx, ctx.b.id, 2, 3);
    await openNight(ctx);
    const first = await names(ctx);
    expect(first).toEqual(['B', 'A', 'C', 'D']);
    await sell(ctx, ctx.d.id, 99, 10);
    await prisma.withTenant(ctx.id, (tx) => tx.serviceItem.create({ data: { tenantId: ctx.id, name: 'Nuevo', category: 'VENUE_BAR', priceCents: 500, sortOrder: 0 } }));
    expect(await names(ctx)).toEqual([...first, 'Nuevo']);
  });

  it('al día siguiente (otra noche) se recalcula', async () => {
    const ctx = await setup();
    await closedNight(ctx, 3);
    await sell(ctx, ctx.b.id, 2, 3);
    const night = await openNight(ctx);
    expect((await names(ctx))[0]).toBe('B');
    await prisma.withTenant(ctx.id, (tx) => tx.venueNight.update({ where: { id: night.id }, data: { closedAt: new Date(BASE + 10 * DAY + 8 * HOUR) } }));
    await sell(ctx, ctx.d.id, 9, 10);
    await prisma.withTenant(ctx.id, (tx) => tx.venueNight.create({ data: { tenantId: ctx.id, openedAt: new Date(BASE + 11 * DAY) } }));
    expect((await names(ctx))[0]).toBe('D');
  });

  it('dos móviles pidiendo la carta a la vez ven el mismo orden', async () => {
    const ctx = await setup();
    await closedNight(ctx, 3);
    await sell(ctx, ctx.c.id, 4, 3);
    await openNight(ctx);
    const lists = await Promise.all([names(ctx), names(ctx), names(ctx), names(ctx)]);
    for (const l of lists) expect(l).toEqual(lists[0]);
    expect(lists[0]![0]).toBe('C');
  });

  it('sin noche abierta, o en el panel, el orden manual de siempre', async () => {
    const ctx = await setup();
    await closedNight(ctx, 3);
    await sell(ctx, ctx.d.id, 9, 3);
    expect(await names(ctx)).toEqual(['A', 'B', 'C', 'D']);
    await openNight(ctx);
    expect((await names(ctx))[0]).toBe('D');
    expect((await service.listAll(ctx.id)).map((i) => i.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('las ventas de otro local no cuentan', async () => {
    const mine = await setup();
    const other = await setup();
    await closedNight(mine, 3);
    await closedNight(other, 3);
    await sell(other, other.d.id, 99, 3);
    await openNight(mine);
    expect(await names(mine)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('«Agotado» esta noche, con PostgreSQL y un rol sin superusuario', () => {
  const soldOutNames = async (ctx: Ctx) => (await service.listForStaff(ctx.id, 'OWNER')).filter((i) => i.soldOut).map((i) => i.name);

  it('vale mientras dure la noche abierta, y al cambiar la noche vuelve solo', async () => {
    const ctx = await setup();
    const night = await openNight(ctx);
    await service.setSoldOut(ctx.id, randomUUID(), ctx.b.id, true);
    expect(await soldOutNames(ctx)).toEqual(['B']);
    expect((await service.listAll(ctx.id)).find((i) => i.name === 'B')?.soldOut).toBe(true);
    // Se cierra la noche y se abre otra: sin tarea programada, ya hay otra vez.
    await prisma.withTenant(ctx.id, (tx) => tx.venueNight.update({ where: { id: night.id }, data: { closedAt: new Date() } }));
    await prisma.withTenant(ctx.id, (tx) => tx.venueNight.create({ data: { tenantId: ctx.id, openedAt: new Date(Date.now() + 1000) } }));
    expect(await soldOutNames(ctx)).toEqual([]);
  });

  it('«Hay otra vez» lo quita en la misma noche', async () => {
    const ctx = await setup();
    await openNight(ctx);
    await service.setSoldOut(ctx.id, randomUUID(), ctx.a.id, true);
    await service.setSoldOut(ctx.id, randomUUID(), ctx.a.id, false);
    expect(await soldOutNames(ctx)).toEqual([]);
  });

  it('otro local no puede marcar un producto que no es suyo', async () => {
    const mine = await setup();
    const other = await setup();
    await openNight(mine);
    await expect(service.setSoldOut(other.id, randomUUID(), mine.a.id, true)).rejects.toThrow();
    expect(await soldOutNames(mine)).toEqual([]);
  });
});
