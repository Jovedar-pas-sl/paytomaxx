import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { DEVICE_IP_RETENTION_BATCH, DeviceIpRetentionService, retentionDaysOf } from './device-ip-retention.service';

const NOW = new Date('2026-11-08T08:00:00.000Z');

function setup(updated: number[] = []) {
  const queue = [...updated];
  const sql: Prisma.Sql[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push(Prisma.sql(strings, ...values));
      return queue.shift() ?? 0;
    }),
    walletGift: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const redis = createFakeRedis();
  return { svc: new DeviceIpRetentionService(prisma as never, redis as never), sql, tx };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('la IP de los dispositivos de los cobros se borra a los 90 días', () => {
  it('todos los locales en una sentencia por vuelta (cada uno por su índice, de 500 en 500), solo en los `payment.device` de antes del corte y con IP', async () => {
    // Primera vuelta: algún local llenó sus 500 (512 en total) → otra; la segunda no llena → se acaba.
    const { svc, sql } = setup([DEVICE_IP_RETENTION_BATCH + 12, 3]);
    expect(await svc.eraseOld(NOW)).toBe(DEVICE_IP_RETENTION_BATCH + 12 + 3);
    expect(sql).toHaveLength(2);
    const q = sql[0]!;
    // Una sola sentencia para todos los locales (antes, una transacción por local).
    expect(q.text).toContain('FROM venues v');
    expect(q.text).toContain('CROSS JOIN LATERAL');
    expect(q.text).toContain('"tenantId" = v.id');
    expect(q.values).toContain(DEVICE_IP_RETENTION_BATCH);
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
    expect(sql).toHaveLength(1);
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

  it('el nombre y el mensaje de los regalos se borran aunque lo de las IP falle o esté apagado', async () => {
    const failing = setup();
    vi.spyOn(failing.svc, 'eraseOld').mockRejectedValueOnce(new Error('base caída'));
    await failing.svc.maybeRun(NOW);
    expect(failing.tx.walletGift.updateMany).toHaveBeenCalled();

    vi.stubEnv('NIGHTPAY_DISABLE_DEVICE_IP_RETENTION', '1');
    const off = setup([1]);
    expect(await off.svc.maybeRun(NOW)).toBe(0);
    expect(off.sql).toHaveLength(0);
    expect(off.tx.walletGift.updateMany).toHaveBeenCalled();
  });
});
