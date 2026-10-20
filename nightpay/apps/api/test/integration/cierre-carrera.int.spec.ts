// Integración (Postgres real, FORCE RLS): la carrera del cierre (revisión 2, M6). Un cobro que se
// confirma MIENTRAS se calcula el Z lleva una hora anterior al corte (NOW() de su transacción) pero no
// se ve hasta su COMMIT. Antes, el Z no lo contaba y el siguiente tampoco (es de antes de su corte):
// quedaba fuera de los dos. Ahora el cierre espera a que termine lo empezado antes del corte
// (night-cutoff.ts) y el cobro sale en ese Z, y solo en ese. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { NIGHT_CLOSE_STEP_KEYS } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { ReportsService } from '../../src/modules/reports/reports.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const config = { get: () => undefined, getOrThrow: () => undefined };
const reports = new ReportsService(prisma);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks);
// La noche se abre «hace 1 h»: que el cierre automático (pasadas las 08:00) no se meta en medio.
vi.spyOn(nights as unknown as { safeAutoClose(tenantId: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);

function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-carrera-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-carrera' });
    return prisma.asSystem(fn);
  });
}

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60 * 1000;
let V: string;
let manager: string;
let term: string;

/** Un cobro con QR de la barra, aún sin pagar, hecho hace 20 min. */
async function unpaidCharge(amountCents: number): Promise<string> {
  return seed(async (tx) => {
    const created = new Date(Date.now() - HOUR / 3);
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: `cc-${r}-${amountCents}`, qrToken: `cc-${r}-${amountCents}`,
        qrExpiresAt: new Date(Date.now() + HOUR), amountCents, availableAmountCents: amountCents, status: 'CREATED',
        revenueCategory: 'VENUE_BAR', createdAt: created,
      } as never,
    });
    return p.id;
  });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, manager, term } = await seed(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Carrera ${r}`, slug: `carrera-${r}` } });
    const m = await tx.user.create({ data: { tenantId: v.id, email: `m-carrera-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `TCC-${r}`, label: 'Barra' } });
    return { V: v.id, manager: m.id, term: t.id };
  }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cierre de la noche con un cobro confirmándose a la vez (Postgres real)', () => {
  it('el cobro que se confirma mientras se calcula el Z sale en ese Z, y no en el siguiente', async () => {
    const opened = await asStaff(V, () => nights.open(V, manager));
    const payment = await unpaidCharge(4200);

    // El banco confirma el cobro: como transition(), con el NOW() de su transacción en la fecha
    // y en el evento «pagado». La transacción se queda abierta (sin COMMIT) hasta `release`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => (wrote = resolve));
    const confirming = seed(async (tx) => {
      await tx.$executeRaw`
        UPDATE payments SET status = 'AUTHORIZED', provider = 'REDSYS', "providerTxId" = ${`CC${r}`},
               "authorizedAt" = NOW(), "updatedAt" = NOW()
         WHERE id = ${payment}::uuid`;
      await tx.$executeRaw`
        INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId")
        VALUES (${payment}::uuid, ${V}::uuid, 'payment.authorized', '{}'::jsonb, 't-carrera')`;
      wrote();
      await gate;
    });
    await written;

    // Se cierra con el cobro aún sin confirmar del todo; el COMMIT llega 400 ms después.
    const closing = asStaff(V, () =>
      nights.close(V, { userId: manager, role: 'MANAGER' }, opened.id, { acknowledged: [...NIGHT_CLOSE_STEP_KEYS], note: 'prueba' }),
    );
    const releaser = setTimeout(release, 400);
    let closed: Awaited<typeof closing>;
    try {
      [, closed] = await Promise.all([confirming, closing]);
    } finally {
      clearTimeout(releaser);
      release();
    }
    const next = await asStaff(V, () => nights.open(V, manager));

    // Contado una vez entre los dos Z (antes: cero, fuera de los dos)…
    const timesCounted = closed.z.summary.count + next.z.summary.count + (next.z.adjustments?.count ?? 0);
    expect(timesCounted).toBe(1);
    // …en el de la noche que se cerró, cuyo corte es el cierre; la siguiente empieza ahí.
    expect(closed.z.summary).toMatchObject({ count: 1, grossCents: 4200 });
    expect(closed.closedAt).toBe(closed.z.generatedAt);
    expect(next.z.from).toBe(closed.closedAt);
  });
});
