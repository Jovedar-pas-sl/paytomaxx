import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { CartaService } from '../../src/modules/carta/carta.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const service = new CartaService(prisma, { log: async () => undefined } as never);
const venues: string[] = [];
beforeAll(async () => { await prisma.onModuleInit(); });
afterAll(async () => {
  await prisma.asSystem(async (tx) => {
    await tx.payment.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.terminal.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.serviceItem.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.venue.deleteMany({ where: { id: { in: venues } } });
  });
  await prisma.onModuleDestroy();
});

async function venue() {
  const row = await prisma.asSystem((tx) => tx.venue.create({ data: { name: 'Carta prueba aislada', slug: `carta-${randomUUID()}` } }));
  venues.push(row.id);
  return row.id;
}
async function products(id: string) {
  return prisma.withTenant(id, (tx) => tx.serviceItem.findMany({ where: { tenantId: id }, orderBy: { name: 'asc' } }));
}

describe('carta reference is atomic with PostgreSQL and a non-superuser role', () => {
  it('serializes a concurrent PATCH converting Copa to a pack after the template snapshot', async () => {
    const id = await venue();
    const item = await prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { tenantId: id, name: 'Copa', category: 'VENUE_BAR', priceCents: 900 } }));
    let snapshot!: (pid: number) => void;
    const snapshotReady = new Promise<number>((resolve) => { snapshot = resolve; });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const pausedPrisma = {
      withTenant: <T>(tenantId: string, fn: (tx: TransactionalClient) => Promise<T>) => prisma.withTenant(tenantId, async (tx) => {
        const delegate = new Proxy(tx.serviceItem, {
          get(target, property) {
            if (property !== 'findMany') return Reflect.get(target, property);
            return async (...args: unknown[]) => {
              const rows = await Reflect.apply(target.findMany, target, args);
              const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
              snapshot(connection!.pid);
              await resume;
              return rows;
            };
          },
        });
        return fn(new Proxy(tx, { get: (target, property) => property === 'serviceItem' ? delegate : Reflect.get(target, property) }));
      }),
    };
    const paused = new CartaService(pausedPrisma as never, { log: async () => undefined } as never);
    const applying = paused.applyTemplate(id, randomUUID(), { confirm: true });
    const pid = await snapshotReady;
    let patchDone = false;
    const patch = cls.run(() => {
      cls.set('ctx', { tenantId: id, traceId: 'carta-race-test' });
      return service.update(id, randomUUID(), item.id, {
        priceCents: 2000, components: [{ category: 'VENUE_BAR', amountCents: 2000 }],
      });
    }).finally(() => { patchDone = true; });
    void patch.catch(() => undefined);
    try {
      // Wait for either the old unsafe PATCH to finish, or the corrected PATCH
      // to block on the real transaction's venue lock. No timing-only race.
      const deadline = Date.now() + 2000;
      while (!patchDone) {
        const [waiting] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
        if (waiting!.blocked) break;
        if (Date.now() > deadline) throw new Error('PATCH neither completed nor reached the venue lock');
      }
    } finally { release(); }
    await Promise.all([applying, patch]);
    const final = (await products(id)).find((row) => row.id === item.id)!;
    expect(final.priceCents).toBe(2000);
    expect(final.components).toEqual([{ category: 'VENUE_BAR', amountCents: 2000 }]);
  });
  it('serializes two administrators, creates 13 once, preserves matches and other venues/products', async () => {
    const id = await venue();
    const other = await venue();
    const before = await prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { tenantId: id, name: ' COPA ', category: 'VENUE_BAR', priceCents: 900, active: false } }));
    const extra = await prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { tenantId: id, name: 'Especial local', category: 'VENUE_BAR', priceCents: 5000 } }));
    const results = await Promise.all([
      service.applyTemplate(id, randomUUID(), { confirm: true }),
      service.applyTemplate(id, randomUUID(), { confirm: true }),
    ]);
    expect(results.map((r) => r.created).sort((a, b) => a - b)).toEqual([0, 12]);
    const rows = await products(id);
    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.id === before.id)).toMatchObject({ priceCents: 1000, active: true });
    expect(rows.find((r) => r.id === extra.id)).toEqual(extra);
    expect(rows.find((r) => r.name === 'Invitar a una copa')).toMatchObject({ priceCents: 2000, isInvitation: true });
    expect(await products(other)).toEqual([]);
  });

  it('prevalidates a conflict at the last product without applying earlier changes', async () => {
    const id = await venue();
    await prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { tenantId: id, name: 'Invitar a una copa', category: 'VENUE_BAR', priceCents: 1000, isInvitation: false } }));
    const before = await products(id);
    await expect(service.applyTemplate(id, randomUUID(), { confirm: true })).rejects.toBeInstanceOf(ConflictException);
    expect(await products(id)).toEqual(before);
  });

  it('retains the service ID and the price/name snapshots of an earlier charge', async () => {
    const id = await venue();
    const history = await prisma.withTenant(id, async (tx) => {
      const item = await tx.serviceItem.create({ data: { tenantId: id, name: 'Copa', category: 'VENUE_BAR', priceCents: 900 } });
      const terminal = await tx.terminal.create({ data: { tenantId: id, externalId: randomUUID(), label: 'Carta test' } });
      const payment = await tx.payment.create({ data: {
        tenantId: id, terminalId: terminal.id, idempotencyKey: randomUUID(), amountCents: 900,
        availableAmountCents: 900, qrToken: randomUUID(), qrExpiresAt: new Date(Date.now() + 60_000),
        serviceItemId: item.id, serviceName: 'Copa de antes',
      } });
      const line = await tx.paymentLine.create({ data: {
        tenantId: id, paymentId: payment.id, serviceItemId: item.id, category: 'VENUE_BAR',
        label: 'Copa de antes', unitCents: 900, amountCents: 900,
      } });
      return { item, payment, line };
    });
    await service.applyTemplate(id, randomUUID(), { confirm: true });
    await prisma.withTenant(id, async (tx) => {
      expect(await tx.serviceItem.findUnique({ where: { id: history.item.id } })).toMatchObject({ priceCents: 1000 });
      expect(await tx.payment.findUnique({ where: { id: history.payment.id } })).toEqual(history.payment);
      expect(await tx.paymentLine.findUnique({ where: { id: history.line.id } })).toEqual(history.line);
    });
  });

  it('rolls back earlier inserts and updates when the last insert fails in PostgreSQL', async () => {
    const id = await venue();
    await prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { tenantId: id, name: 'Copa', category: 'VENUE_BAR', priceCents: 900 } }));
    const before = await products(id);
    const functionName = `carta_fail_${randomUUID().replace(/-/g, '')}`;
    // The trigger only matches this generated test venue. Identifiers and UUID
    // are generated internally; no application input is interpolated into SQL.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId" = '${id}'::uuid AND NEW.name = 'Invitar a una copa' THEN RAISE EXCEPTION 'injected carta write failure'; END IF; RETURN NEW; END $$`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON service_items FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(service.applyTemplate(id, randomUUID(), { confirm: true })).rejects.toThrow(/injected carta write failure/);
      expect(await products(id)).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${functionName} ON service_items`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }
  });
});
