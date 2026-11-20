// Integración (Postgres real): la referencia corta (C-0001) con muchos cobros
// del mismo local a la vez (prueba de carga del 19-11-2026). El contador del
// local se toma como última sentencia de la transacción del cobro: mientras
// uno lo tiene, los demás ya han guardado todo lo suyo (no esperan en fila
// cinco sentencias) y nunca se repite una referencia. np_app y FORCE RLS.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const queue = { add: vi.fn(async () => undefined) };
const metrics = {
  paymentsCreated: { inc: noop },
  paymentsTransitioned: { inc: noop },
  walletCreditSkipped: { inc: noop },
  duplicateCharges: { inc: noop },
};
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, { log: vi.fn(async () => undefined) } as never, { get: () => ({}) } as never, {} as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 'ref' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string, carlos: string, copa: string;
let n = 0;

/** El cobro de «Cobrar» (tarjeta con su saldo enlazado, como las apps de ahora). */
const cobro = () =>
  inVenue(V, () =>
    payments.create(
      V,
      `ref-${r}-${(n += 1)}`,
      { currency: 'EUR', terminalExternalId: `REF-${r}`, lines: [{ serviceItemId: copa, qty: 1 }], withSaldo: true } as never,
      { userId: carlos, role: 'WAITER' },
    ),
  );
/** El cobro del saldo suelto (QR y Face ID, ficha o PIN). */
const cobroSaldo = () => inVenue(V, () => charges.createQrCharge({ userId: carlos, role: 'WAITER', tenantId: V }, { amountCents: 800 }));

/** Todas las referencias del local: de los cobros con tarjeta y de los del saldo sueltos. */
async function refsOfVenue(): Promise<{ payments: Array<{ id: string; ref: number | null }>; saldo: Array<{ linkedPaymentId: string | null; ref: number | null }> }> {
  return sys(async (tx) => ({
    payments: await tx.payment.findMany({ where: { tenantId: V }, select: { id: true, ref: true } }),
    saldo: await tx.walletChargeRequest.findMany({ where: { tenantId: V }, select: { linkedPaymentId: true, ref: true } }),
  }));
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Aguante', slug: `ref-${r}`, walletGroup: `gref-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `REF-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    carlos = (
      await tx.user.create({ data: { tenantId: V, email: `carlos-ref-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Carlos' } })
    ).id;
    copa = (await tx.serviceItem.create({ data: { tenantId: V, name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('referencias del local con muchos cobros a la vez', () => {
  it('24 cobros a la vez (tarjeta con saldo y saldo suelto): todos terminan, sin esperas largas y sin repetir referencia', async () => {
    const started = Date.now();
    const out = await Promise.allSettled(
      Array.from({ length: 24 }, async (_, i) => {
        const t0 = Date.now();
        await (i % 3 === 2 ? cobroSaldo() : cobro());
        return Date.now() - t0;
      }),
    );
    expect(out.filter((o) => o.status === 'rejected')).toEqual([]);
    const slowest = Math.max(...out.map((o) => (o as PromiseFulfilledResult<number>).value));
    // Con 4 conexiones en las pruebas: segundos de sobra; en fila durante otras cinco sentencias, mucho más con carga.
    expect(slowest).toBeLessThan(10_000);
    expect(Date.now() - started).toBeLessThan(15_000);

    const refs = await refsOfVenue();
    const twinRef = new Map(refs.saldo.filter((s) => s.linkedPaymentId).map((s) => [s.linkedPaymentId!, s.ref]));
    // Cobro único: el cobro con tarjeta y su saldo enlazado llevan la misma referencia.
    for (const p of refs.payments) expect(twinRef.get(p.id)).toBe(p.ref);
    const all = [...refs.payments.map((p) => p.ref), ...refs.saldo.filter((s) => !s.linkedPaymentId).map((s) => s.ref)];
    expect(all).toHaveLength(24);
    expect(all.every((ref) => Number.isInteger(ref) && ref! > 0)).toBe(true);
    // Seguidas y sin repetir: 1, 2, 3… 24 (el local es nuevo).
    expect([...all].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it.each([
    ['cobro con tarjeta y su saldo', cobro, ['payments', 'payment_lines', 'wallet_charge_requests', 'payment_events']],
    ['cobro del saldo suelto', cobroSaldo, ['wallet_charge_requests', 'payment_lines']],
  ] as const)('%s: el contador del local se toma lo último (mientras otro lo tiene, ya ha guardado todo lo demás)', async (_name, create, tables) => {
    await cobro(); // la fila del contador del local ya existe
    // Otra transacción tiene la fila del contador (como otro cobro a punto de terminar).
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let blocking: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (blocking = resolve));
    const blocker = sys(
      async (tx) => {
        await tx.$queryRaw`SELECT "lastRef" FROM charge_ref_counters WHERE "tenantId" = ${V}::uuid FOR UPDATE`;
        blocking();
        await held;
      },
      { timeout: 30_000 },
    );
    await blocked;
    const before = (await refsOfVenue()).payments.length + (await refsOfVenue()).saldo.length;
    const pending = create();
    try {
      // El cobro llega al contador y espera a la otra transacción.
      let pid: number | null = null;
      for (let i = 0; i < 200 && pid === null; i++) {
        const waiting = await sys((tx) =>
          tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%charge_ref_counters%'
          `,
        );
        pid = waiting[0]?.pid ?? null;
        if (pid === null) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pid).not.toBeNull();
      // Lo demás del cobro ya está escrito en su transacción (sus tablas, con RowExclusiveLock).
      const locked = await sys((tx) =>
        tx.$queryRaw<Array<{ relname: string }>>`
          SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE l.pid = ${pid}::int AND l.granted AND l.mode = 'RowExclusiveLock'
        `,
      );
      expect(locked.map((x) => x.relname)).toEqual(expect.arrayContaining([...tables]));
    } finally {
      release();
      await blocker;
    }
    await pending;
    const after = await refsOfVenue();
    expect(after.payments.length + after.saldo.length).toBeGreaterThan(before);
    const refs = [...after.payments.map((p) => p.ref), ...after.saldo.filter((s) => !s.linkedPaymentId).map((s) => s.ref)];
    expect(new Set(refs).size).toBe(refs.length);
  });
});
