// Integración (Postgres real, np_app): las restricciones de dinero de la base
// (migración 20261029400100_check_dinero, DI-07). Antes solo las validaban
// zod y los servicios. check-drift no mira los CHECK: si una migración los
// quitara, o si alguien los cambiara, falla aquí. Y la migración: se puede
// repetir y, con una fila antigua que no cumpla, no rompe el despliegue (queda
// NOT VALID y obliga a las nuevas).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';

const prisma = new PrismaService(new ClsService(new AsyncLocalStorage()) as never);
const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>): Promise<T> => prisma.asSystem(fn);

const DB_PKG = join(__dirname, '../../../../packages/db');
const MIGRATION = join(DB_PKG, 'prisma/migrations/20261029400100_check_dinero/migration.sql');
const CHECKS = [
  ['payments', 'payments_amount_positive'],
  ['payments', 'payments_commission_bps_range'],
  ['refunds', 'refunds_amount_positive'],
  ['operator_earnings', 'operator_earnings_commission_nonneg'],
  ['operator_earnings', 'operator_earnings_commission_bps_range'],
] as const;

const r = randomUUID().slice(0, 8);
let V = '';
let term = '';
let user = '';
let paid = '';
let k = 0;

beforeAll(async () => {
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Dinero', slug: `dinero-${r}` } })).id;
    term = (await tx.terminal.create({ data: { tenantId: V, externalId: `T-${r}`, label: 'T' } })).id;
    user = (await tx.user.create({ data: { tenantId: V, email: `chica-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
  });
  paid = (await payment({ amountCents: 1000, status: 'AUTHORIZED' })).id;
});

afterAll(async () => {
  await sys(async (tx) => {
    await tx.operatorEarning.deleteMany({ where: { tenantId: V } });
    await tx.refund.deleteMany({ where: { tenantId: V } });
    await tx.payment.deleteMany({ where: { tenantId: V } });
    await tx.user.deleteMany({ where: { tenantId: V } });
    await tx.terminal.deleteMany({ where: { tenantId: V } });
    await tx.venue.deleteMany({ where: { id: V } });
  });
  await prisma.$disconnect();
});

function payment(o: Record<string, unknown>) {
  k += 1;
  return sys((tx) =>
    tx.payment.create({
      data: {
        tenantId: V,
        terminalId: term,
        idempotencyKey: `din-${r}-${k}`,
        amountCents: 1000,
        availableAmountCents: 0,
        qrToken: `din-${r}-${k}`,
        qrExpiresAt: new Date(Date.now() + 60_000),
        ...o,
      } as never,
    }),
  );
}

const refund = (amountCents: number) =>
  sys((tx) => tx.refund.create({ data: { tenantId: V, paymentId: paid, amountCents, requestedBy: user, status: 'SUCCEEDED' } as never }));

const earning = (o: { commissionCents?: number; commissionBps?: number }) =>
  sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: `din-e-${r}-${++k}`, amountCents: 1000, availableAmountCents: 1000,
        qrToken: `din-e-${r}-${k}`, qrExpiresAt: new Date(Date.now() + 60_000), status: 'AUTHORIZED',
      } as never,
    });
    return tx.operatorEarning.create({
      data: { tenantId: V, operatorId: user, paymentId: p.id, paymentAmountCents: 1000, commissionBps: 1000, commissionCents: 100, ...o },
    });
  });

/** Lo que dice Postgres al saltarse una restricción (código 23514 y su nombre). */
async function rejectedBy(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e as { message?: string },
  );
  expect(err).not.toBeNull();
  const text = String(err?.message ?? err);
  expect(text).toMatch(/23514|violates check constraint/);
  return text;
}

async function checks(): Promise<Array<{ table: string; name: string; valid: boolean }>> {
  return prisma.$queryRaw<Array<{ table: string; name: string; valid: boolean }>>`
    SELECT conrelid::regclass::text AS table, conname AS name, convalidated AS valid
      FROM pg_constraint
     WHERE conname IN ('payments_amount_positive', 'payments_commission_bps_range', 'refunds_amount_positive',
                       'operator_earnings_commission_nonneg', 'operator_earnings_commission_bps_range')
     ORDER BY conname`;
}

function runMigration(): { status: number | null; out: string } {
  const cli = join(DB_PKG, 'node_modules/prisma/build/index.js');
  const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
    encoding: 'utf8',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

describe('restricciones de dinero (20261029400100_check_dinero)', () => {
  it('están las cinco, validadas', async () => {
    const found = await checks();
    expect(found.map((c) => [c.table, c.name]).sort()).toEqual([...CHECKS].map((c) => [...c]).sort());
    expect(found.every((c) => c.valid)).toBe(true);
  });

  it('un cobro de 0 € o negativo no se guarda', async () => {
    expect(await rejectedBy(payment({ amountCents: 0 }))).toContain('payments_amount_positive');
    expect(await rejectedBy(payment({ amountCents: -500 }))).toContain('payments_amount_positive');
    await expect(payment({ amountCents: 1 })).resolves.toBeTruthy();
  });

  it('el % de la plataforma o de la chica, de 0 a 10000 (o sin poner)', async () => {
    expect(await rejectedBy(payment({ platformCommissionBps: 10_001 }))).toContain('payments_commission_bps_range');
    expect(await rejectedBy(payment({ operatorCommissionBps: -1 }))).toContain('payments_commission_bps_range');
    await expect(payment({ platformCommissionBps: 10_000, operatorCommissionBps: 0 })).resolves.toBeTruthy();
    await expect(payment({ platformCommissionBps: null, operatorCommissionBps: null })).resolves.toBeTruthy();
  });

  it('una devolución de 0 € o negativa no se guarda', async () => {
    expect(await rejectedBy(refund(0))).toContain('refunds_amount_positive');
    expect(await rejectedBy(refund(-100))).toContain('refunds_amount_positive');
    await expect(refund(100)).resolves.toBeTruthy();
  });

  it('la comisión de la chica no es negativa y su % va de 0 a 10000 (0 vale: la fila de solo propina)', async () => {
    expect(await rejectedBy(earning({ commissionCents: -1 }))).toContain('operator_earnings_commission_nonneg');
    expect(await rejectedBy(earning({ commissionBps: 10_001 }))).toContain('operator_earnings_commission_bps_range');
    await expect(earning({ commissionCents: 0, commissionBps: 0 })).resolves.toBeTruthy();
  });
});

describe('la migración 20261029400100_check_dinero', () => {
  it('se puede repetir: lo mismo, sin error', async () => {
    const before = await checks();
    const again = runMigration();
    expect(again.status).toBe(0);
    expect(await checks()).toEqual(before);
  }, 120_000);

  it('con una fila antigua que no cumple: no rompe el despliegue; queda NOT VALID y obliga a las nuevas', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE payments DROP CONSTRAINT payments_amount_positive');
    const odd = await payment({ amountCents: 0 });
    try {
      const res = runMigration();
      expect(res.status).toBe(0);
      const c = (await checks()).find((x) => x.name === 'payments_amount_positive');
      expect(c?.valid).toBe(false);
      expect(await rejectedBy(payment({ amountCents: 0 }))).toContain('payments_amount_positive');
    } finally {
      await sys((tx) => tx.payment.delete({ where: { id: odd.id } }));
    }
    // Arreglada la fila, otra vez: queda validada.
    expect(runMigration().status).toBe(0);
    expect((await checks()).find((x) => x.name === 'payments_amount_positive')?.valid).toBe(true);
  }, 240_000);
});
