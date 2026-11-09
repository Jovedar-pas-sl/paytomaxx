import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { DEVICE_IP_RETENTION_BATCH, DeviceIpRetentionService, retentionDaysOf } from './device-ip-retention.service';

const NOW = new Date('2026-11-08T08:00:00.000Z');
const SALA = 'a1a1a1a1-0000-4000-8000-000000000001';
const NEON = 'a1a1a1a1-0000-4000-8000-000000000002';

function setup(updated: number[] = []) {
  const queue = [...updated];
  const sql: Prisma.Sql[] = [];
  const tx = {
    venue: { findMany: vi.fn(async () => [{ id: SALA }, { id: NEON }]) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push(Prisma.sql(strings, ...values));
      return queue.shift() ?? 0;
    }),
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const redis = createFakeRedis();
  return { svc: new DeviceIpRetentionService(prisma as never, redis as never), sql };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('la IP de los dispositivos de los cobros se borra a los 90 días', () => {
  it('local a local y de 500 en 500, solo en los `payment.device` de antes del corte y con IP', async () => {
    const { svc, sql } = setup([DEVICE_IP_RETENTION_BATCH, 12, 3]);
    expect(await svc.eraseOld(NOW)).toBe(DEVICE_IP_RETENTION_BATCH + 12 + 3);
    // La Sala: una vuelta llena y otra; Neón: una.
    expect(sql.map((q) => q.values[0])).toEqual([SALA, SALA, NEON]);
    const q = sql[0]!;
    expect(q.text).toContain("payload - 'ip'");
    expect(q.text).toContain('"ipErased": true');
    expect(q.text).toContain("payload ->> 'ip' IS NOT NULL");
    expect(q.values).toContain('payment.device');
    // El corte: 90 días antes.
    expect(q.values).toContainEqual(new Date('2026-08-10T08:00:00.000Z'));
  });

  it('como mucho cada 6 h entre las réplicas (lo lanza el repaso de cada 10 min)', async () => {
    const { svc, sql } = setup([1]);
    expect(await svc.maybeRun(NOW)).toBe(1);
    expect(await svc.maybeRun(new Date(NOW.getTime() + 10 * 60_000))).toBe(0);
    expect(sql).toHaveLength(2);
  });

  it('se apaga con NIGHTPAY_DISABLE_DEVICE_IP_RETENTION=1; los días, con DEVICE_IP_RETENTION_DAYS', async () => {
    vi.stubEnv('NIGHTPAY_DISABLE_DEVICE_IP_RETENTION', '1');
    const { svc, sql } = setup([1]);
    expect(await svc.maybeRun(NOW)).toBe(0);
    expect(sql).toHaveLength(0);
    expect(retentionDaysOf('30')).toBe(30);
    expect(retentionDaysOf('0')).toBe(90);
    expect(retentionDaysOf('abc')).toBe(90);
    expect(retentionDaysOf(undefined)).toBe(90);
  });

  it('si la base falla, no tumba el repaso que lo lanza', async () => {
    const { svc } = setup();
    vi.spyOn(svc, 'eraseOld').mockRejectedValueOnce(new Error('base caída'));
    await expect(svc.maybeRun(NOW)).resolves.toBe(0);
  });
});
