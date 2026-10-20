import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { CUTOFF_SETTLE_MAX_WAIT_MS, CUTOFF_STALE_TX_MS, settleWritesBefore } from './night-cutoff';

const CUTOFF = new Date('2026-10-23T04:30:00Z');

/** La base contesta, vuelta a vuelta, lo que diga `answers` (la última se repite). */
function fakeDb(answers: Array<{ past: boolean; open: number }>) {
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(Prisma.sql(strings, ...values));
    return [answers[Math.min(queries.length - 1, answers.length - 1)]];
  });
  return { db: { $queryRaw } as never, $queryRaw, queries };
}

/** Esperar = adelantar el reloj (falso) lo que se espera. */
const sleep = vi.fn(async (ms: number) => {
  vi.setSystemTime(Date.now() + ms);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CUTOFF.getTime() + 5);
  sleep.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('antes de leer el Z: que termine lo que empezó antes del corte', () => {
  it('sin nada abierto y con el reloj de la base pasado el corte: se lee ya (una consulta)', async () => {
    const { db, queries } = fakeDb([{ past: true, open: 0 }]);
    expect(await settleWritesBefore(db, CUTOFF, { sleep })).toEqual({ settled: true, open: 0, waitedMs: 0 });
    expect(queries).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    // Las transacciones de las otras sesiones de esta base empezadas antes del corte (no las de hace más de 1 min).
    const sql = queries[0]!;
    expect(sql.text).toContain('pg_stat_activity');
    expect(sql.text).toContain('pg_backend_pid()');
    expect(sql.text).toContain('xact_start');
    expect(sql.text).toContain('clock_timestamp()');
    expect(sql.values).toEqual([CUTOFF, CUTOFF, new Date(CUTOFF.getTime() - CUTOFF_STALE_TX_MS)]);
  });

  it('un cobro confirmándose (transacción abierta de antes del corte): se espera a que termine', async () => {
    const { db, queries } = fakeDb([
      { past: true, open: 2 },
      { past: true, open: 1 },
      { past: true, open: 0 },
    ]);
    const result = await settleWritesBefore(db, CUTOFF, { sleep, pollMs: 50 });
    expect(result).toEqual({ settled: true, open: 0, waitedMs: 100 });
    expect(queries).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('el reloj del servidor va por delante del de la base: se espera a que la base pase el corte', async () => {
    const { db, queries } = fakeDb([
      { past: false, open: 0 },
      { past: true, open: 0 },
    ]);
    await expect(settleWritesBefore(db, CUTOFF, { sleep })).resolves.toMatchObject({ settled: true });
    expect(queries).toHaveLength(2);
  });

  it('algo sigue abierto pasado el plazo: se rinde (y lo dice) en vez de colgar el cierre', async () => {
    const { db } = fakeDb([{ past: true, open: 1 }]);
    const result = await settleWritesBefore(db, CUTOFF, { sleep });
    expect(result).toMatchObject({ settled: false, open: 1 });
    expect(result.waitedMs).toBeGreaterThanOrEqual(CUTOFF_SETTLE_MAX_WAIT_MS);
  });

  it('con el reloj parado tampoco se queda para siempre (tope de vueltas)', async () => {
    const { db, queries } = fakeDb([{ past: true, open: 1 }]);
    const stuck = vi.fn(async () => undefined);
    await expect(settleWritesBefore(db, CUTOFF, { sleep: stuck, maxWaitMs: 500, pollMs: 50 })).resolves.toMatchObject({
      settled: false,
    });
    expect(queries).toHaveLength(11);
  });
});
