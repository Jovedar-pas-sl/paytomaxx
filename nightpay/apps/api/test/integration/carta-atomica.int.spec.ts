import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { cartaTemplateSeen } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { CartaService } from '../../src/modules/carta/carta.service';

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
    await tx.serviceItem.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.venue.deleteMany({ where: { id: { in: venues } } });
  });
  await prisma.onModuleDestroy();
});

async function venue(sections?: Record<string, unknown>) {
  const row = await prisma.asSystem((tx) => tx.venue.create({
    data: { name: 'Carta prueba aislada', slug: `carta-${randomUUID()}`, ...(sections ? { sections } : {}) },
  }));
  venues.push(row.id);
  return row.id;
}
async function products(id: string) {
  return prisma.withTenant(id, (tx) => tx.serviceItem.findMany({ where: { tenantId: id }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }));
}
type Item = Awaited<ReturnType<typeof products>>[number];
async function item(id: string, data: Partial<Omit<Item, 'id' | 'tenantId' | 'components'>> & { name: string }) {
  return prisma.withTenant(id, (tx) => tx.serviceItem.create({ data: { category: 'VENUE_BAR', priceCents: 1000, ...data, tenantId: id } }));
}
const tick = (row: Item) => ({ id: row.id, seen: cartaTemplateSeen(row) });

/** La plantilla parada justo después de leer la carta, con el local ya bloqueado. */
function pausedCarta() {
  let ready!: (pid: number) => void;
  const snapshot = new Promise<number>((resolve) => { ready = resolve; });
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
            ready(connection!.pid);
            await resume;
            return rows;
          };
        },
      });
      return fn(new Proxy(tx, { get: (target, property) => property === 'serviceItem' ? delegate : Reflect.get(target, property) }));
    }),
  };
  return { service: new CartaService(pausedPrisma as never, { log: async () => undefined } as never), snapshot, release };
}

/** Una carta que el dueño ya tocó: Copa a 9 € y desactivada, Botella con su orden, una invitación propia y un producto suyo. */
async function editedCarta(id: string) {
  return {
    copa: await item(id, { name: ' COPA ', priceCents: 900, active: false }),
    botella: await item(id, { name: 'Botella', priceCents: 15000, sortOrder: 7 }),
    invitation: await item(id, { name: 'Invita a Nerea', priceCents: 2500, isInvitation: true }),
    extra: await item(id, { name: 'Especial local', priceCents: 5000 }),
  };
}

describe('carta de referencia: atómica, con PostgreSQL y un rol sin superusuario', () => {
  it('con una carta ya editada, dos administradores a la vez solo añaden lo que falta, una vez, y no tocan lo del dueño', async () => {
    const id = await venue();
    const other = await venue();
    const mine = await editedCarta(id);
    const results = await Promise.all([
      service.applyTemplate(id, randomUUID(), { confirm: true }),
      service.applyTemplate(id, randomUUID(), { confirm: true }),
    ]);
    // Copa y Botella existen; la invitación ya existe con otro nombre: 10 nuevos.
    expect(results.map((r) => r.created).sort((a, b) => a - b)).toEqual([0, 10]);
    expect(results.every((r) => r.updated === 0 && r.skipped === 1)).toBe(true);
    const rows = await products(id);
    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.id === mine.copa.id)).toEqual(mine.copa);
    expect(rows.find((r) => r.id === mine.botella.id)).toEqual(mine.botella);
    expect(rows.find((r) => r.id === mine.extra.id)).toEqual(mine.extra);
    expect(rows.filter((r) => r.isInvitation)).toEqual([mine.invitation]);
    expect(await products(other)).toEqual([]);
  });

  it('dos administradores marcan la misma copa: uno la actualiza y el otro ve que ya está, sin duplicar ni fallar', async () => {
    const id = await venue();
    const mine = await editedCarta(id);
    const results = await Promise.all([
      service.applyTemplate(id, randomUUID(), { confirm: true, update: [tick(mine.copa)] }),
      service.applyTemplate(id, randomUUID(), { confirm: true, update: [tick(mine.copa)] }),
    ]);
    expect(results.map((r) => r.updated).sort()).toEqual([0, 1]);
    const copa = (await products(id)).find((r) => r.id === mine.copa.id)!;
    // Solo lo que dice la referencia: el nombre del dueño se queda.
    expect(copa).toMatchObject({ name: ' COPA ', priceCents: 1000, active: true, sortOrder: 0 });
  });

  it('si otro administrador cambia el precio después de marcarlo, 409 y no se escribe nada (tampoco lo que faltaba)', async () => {
    const id = await venue();
    const mine = await editedCarta(id);
    const seen = tick(mine.copa);
    await cls.run(() => {
      cls.set('ctx', { tenantId: id, traceId: 'carta-stale-tick' });
      return service.update(id, randomUUID(), mine.copa.id, { priceCents: 1200 });
    });
    const before = await products(id);
    await expect(service.applyTemplate(id, randomUUID(), { confirm: true, update: [seen] })).rejects.toBeInstanceOf(ConflictException);
    expect(await products(id)).toEqual(before);
    expect(before.find((r) => r.id === mine.copa.id)?.priceCents).toBe(1200);
  });

  it('omite una sección apagada y un producto con el nombre de la invitación que no lo es, y añade el resto', async () => {
    const id = await venue({ VENUE_FOOD: { enabled: false } });
    const fake = await item(id, { name: 'Invitar a una copa', priceCents: 1000 });
    const result = await service.applyTemplate(id, randomUUID(), { confirm: true });
    expect(result).toEqual({ created: 10, updated: 0, kept: 0, skipped: 3 });
    const rows = await products(id);
    expect(rows.filter((r) => r.category === 'VENUE_FOOD')).toEqual([]);
    expect(rows.filter((r) => r.name === 'Invitar a una copa')).toEqual([fake]);
    expect(rows.some((r) => r.isInvitation)).toBe(false);
  });

  it('serializa un PATCH que convierte la copa en pack mientras la plantilla la actualiza', async () => {
    const id = await venue();
    const copa = await item(id, { name: 'Copa', priceCents: 900 });
    const paused = pausedCarta();
    const applying = paused.service.applyTemplate(id, randomUUID(), { confirm: true, update: [tick(copa)] });
    const pid = await paused.snapshot;
    let patchDone = false;
    const patch = cls.run(() => {
      cls.set('ctx', { tenantId: id, traceId: 'carta-race-test' });
      return service.update(id, randomUUID(), copa.id, { priceCents: 2000, components: [{ category: 'VENUE_BAR', amountCents: 2000 }] });
    }).finally(() => { patchDone = true; });
    void patch.catch(() => undefined);
    try {
      // O el PATCH acaba (sin candado) o se queda esperando el candado del local. Sin carreras por tiempo.
      const deadline = Date.now() + 2000;
      while (!patchDone) {
        const [waiting] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
        if (waiting!.blocked) break;
        if (Date.now() > deadline) throw new Error('PATCH neither completed nor reached the venue lock');
      }
      expect(patchDone).toBe(false);
    } finally { paused.release(); }
    await Promise.all([applying, patch]);
    const final = (await products(id)).find((row) => row.id === copa.id)!;
    expect(final.priceCents).toBe(2000);
    expect(final.components).toEqual([{ category: 'VENUE_BAR', amountCents: 2000 }]);
  });

  it('mientras la plantilla tiene la carta bloqueada, los cobros del local no esperan', async () => {
    const id = await venue();
    const terminal = await prisma.withTenant(id, (tx) => tx.terminal.create({ data: { tenantId: id, externalId: randomUUID(), label: 'Carta test' } }));
    const paused = pausedCarta();
    const applying = paused.service.applyTemplate(id, randomUUID(), { confirm: true });
    await paused.snapshot;
    try {
      // Si el candado frenara el cobro (su clave ajena al local), falla a los 2 s en vez de colgar la prueba.
      const payment = await prisma.withTenant(id, async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        return tx.payment.create({ data: {
          tenantId: id, terminalId: terminal.id, idempotencyKey: randomUUID(), amountCents: 900,
          availableAmountCents: 900, qrToken: randomUUID(), qrExpiresAt: new Date(Date.now() + 60_000),
        } });
      });
      expect(payment.tenantId).toBe(id);
    } finally { paused.release(); }
    await expect(applying).resolves.toMatchObject({ created: 13 });
  });

  it('conserva el id del producto y lo copiado en un cobro anterior', async () => {
    const id = await venue();
    const history = await prisma.withTenant(id, async (tx) => {
      const product = await tx.serviceItem.create({ data: { tenantId: id, name: 'Copa', category: 'VENUE_BAR', priceCents: 900 } });
      const terminal = await tx.terminal.create({ data: { tenantId: id, externalId: randomUUID(), label: 'Carta test' } });
      const payment = await tx.payment.create({ data: {
        tenantId: id, terminalId: terminal.id, idempotencyKey: randomUUID(), amountCents: 900,
        availableAmountCents: 900, qrToken: randomUUID(), qrExpiresAt: new Date(Date.now() + 60_000),
        serviceItemId: product.id, serviceName: 'Copa de antes',
      } });
      const line = await tx.paymentLine.create({ data: {
        tenantId: id, paymentId: payment.id, serviceItemId: product.id, category: 'VENUE_BAR',
        label: 'Copa de antes', unitCents: 900, amountCents: 900,
      } });
      return { product, payment, line };
    });
    await service.applyTemplate(id, randomUUID(), { confirm: true, update: [tick(history.product)] });
    await prisma.withTenant(id, async (tx) => {
      expect(await tx.serviceItem.findUnique({ where: { id: history.product.id } })).toMatchObject({ priceCents: 1000 });
      expect(await tx.payment.findUnique({ where: { id: history.payment.id } })).toEqual(history.payment);
      expect(await tx.paymentLine.findUnique({ where: { id: history.line.id } })).toEqual(history.line);
    });
  });

  it('si falla la última escritura en PostgreSQL, deshace lo añadido y lo actualizado', async () => {
    const id = await venue();
    const copa = await item(id, { name: 'Copa', priceCents: 900 });
    const botella = await item(id, { name: 'Botella', priceCents: 12000, sortOrder: 2, active: false });
    const before = await products(id);
    const functionName = `carta_fail_${randomUUID().replace(/-/g, '')}`;
    // El disparador solo afecta a esta Botella: identificador y UUID generados aquí, nada de la aplicación en el SQL.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${botella.id}'::uuid THEN RAISE EXCEPTION 'injected carta write failure'; END IF; RETURN NEW; END $$`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE UPDATE ON service_items FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(service.applyTemplate(id, randomUUID(), { confirm: true, update: [tick(copa), tick(botella)] })).rejects.toThrow(/injected carta write failure/);
      expect(await products(id)).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${functionName} ON service_items`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }
  });
});
