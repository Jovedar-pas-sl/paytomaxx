import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@nightpay/db';
import { TreasuryService } from './treasury.service';

/**
 * «Pagos de este mes» en Tesorería: el mes es el de Madrid. Producción corre
 * en UTC; la prueba fija TZ=UTC para no depender de la zona del equipo.
 */

const TENANT = '7d3c1f0e-2b4a-4c8e-9f10-1a2b3c4d5e6f';

function makeTreasury() {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: null }) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(Prisma.sql(strings, ...values));
      return [];
    }),
    withTenant: vi.fn(async (tenantId: string, fn: (tx: unknown) => unknown) => {
      expect(tenantId).toBe(TENANT);
      return fn(prisma);
    }),
  };
  const config = { get: vi.fn(() => undefined) };
  const svc = new TreasuryService(prisma as never, { log: vi.fn() } as never, {} as never, config as never);
  return { svc, queries };
}

/** Desde cuándo cuenta «este mes» la consulta de pagos del mes. */
function monthStartOf(queries: Prisma.Sql[]): Date {
  const q = queries.find((x) => x.text.includes('FROM operator_payouts') && x.text.includes('"createdAt" >='))!;
  expect(q.text).toContain('"tenantId" = $');
  expect(q.values).toContain(TENANT);
  return q.values.find((v): v is Date => v instanceof Date)!;
}

describe('Tesorería — pagos de este mes en hora de Madrid', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('a las 00:30 del 1 de noviembre en Madrid ya es noviembre (no cuenta los pagos de octubre)', async () => {
    // 00:30 del 1-nov en Madrid (invierno, UTC+1) = 23:30 UTC del 31-oct.
    vi.setSystemTime(new Date('2026-10-31T23:30:00Z'));
    const { svc, queries } = makeTreasury();
    await svc.getStats(TENANT);
    expect(monthStartOf(queries)).toEqual(new Date('2026-10-31T23:00:00Z'));
  });

  it('en verano el mes empieza a las 22:00 UTC del último día del mes anterior', async () => {
    vi.setSystemTime(new Date('2026-07-15T10:00:00Z'));
    const { svc, queries } = makeTreasury();
    await svc.getStats(TENANT);
    expect(monthStartOf(queries)).toEqual(new Date('2026-06-30T22:00:00Z'));
  });

  it('el día del cambio de hora (25-oct) sigue contando desde el 1 de octubre a las 00:00 de Madrid', async () => {
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const { svc, queries } = makeTreasury();
    await svc.getStats(TENANT);
    expect(monthStartOf(queries)).toEqual(new Date('2026-09-30T22:00:00Z'));
  });
});
