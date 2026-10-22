import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NEEDS_HUMAN_AFTER_ATTEMPTS, RefundReversalSweepService, nextRetryDelayMs } from './refund-reversal-sweep.service';

interface Missing {
  refundId: string;
  paymentId: string;
  tenantId: string;
  amountCents: number;
  attempts?: number;
}

const rowA: Missing = { refundId: 'r-a', paymentId: 'p-a', tenantId: 't-1', amountCents: 1500 };
const rowB: Missing = { refundId: 'r-b', paymentId: 'p-b', tenantId: 't-2', amountCents: 900 };
const MIN = 60_000;

/**
 * Base en memoria: las filas pendientes con su siguiente intento, intentos y
 * último error. La consulta de las que tocan respeta la fecha y el orden
 * (la que más espera primero), como la SQL de verdad.
 */
function make(missing: Missing[], stillMissingAfter: string[] = []) {
  const rows = new Map(
    missing.map((m) => [m.refundId, { ...m, attempts: m.attempts ?? 0, retryAt: null as Date | null, lastError: null as string | null }]),
  );
  const sqls: string[] = [];
  const params: unknown[][] = [];
  type Update = {
    where: { id: string; earningReversalAttempts: number };
    data: { earningReversalAttempts: number; earningReversalRetryAt: Date; earningReversalLastError: string };
  };
  const tx = {
    refund: {
      updateMany: vi.fn(async ({ where, data }: Update) => {
        const r = rows.get(where.id);
        if (!r || r.attempts !== where.earningReversalAttempts) return { count: 0 };
        Object.assign(r, { attempts: data.earningReversalAttempts, retryAt: data.earningReversalRetryAt, lastError: data.earningReversalLastError });
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(values);
      if (sql.includes('LIMIT')) {
        const now = values[1] as Date;
        return [...rows.values()]
          .filter((r) => !r.retryAt || r.retryAt <= now)
          .sort((a, b) => (a.retryAt?.getTime() ?? 0) - (b.retryAt?.getTime() ?? 0))
          .slice(0, 100)
          .map(({ refundId, paymentId, tenantId, amountCents, attempts }) => ({ refundId, paymentId, tenantId, amountCents, attempts }));
      }
      // Comprobación posterior: ¿ya hay fila en earning_reversals?
      const refundId = values[0] as string;
      if (stillMissingAfter.includes(refundId)) return [];
      rows.delete(refundId);
      return [{ ok: 1 }];
    }),
  };
  const prisma = { asSystem: vi.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const payments = { applyRefundToEarning: vi.fn().mockResolvedValue(undefined) };
  const metrics = { earningReversalFailed: { inc: vi.fn() }, observeEarningReversals: vi.fn(() => vi.fn()) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new RefundReversalSweepService(prisma as never, payments as never, metrics as never, audit as never);
  return { svc, prisma, payments, metrics, audit, sqls, params, rows, tx };
}

describe('RefundReversalSweepService.sweep — reintenta el descuento a la chica', () => {
  it('100 fallos persistentes no dejan sin procesar la devolución 101, incluso tras reiniciar el servicio', async () => {
    const list = Array.from({ length: 101 }, (_, i) => ({ ...rowA, refundId: 'r-' + i, paymentId: 'p-' + i }));
    const { svc, payments, prisma, metrics, audit } = make(list);
    payments.applyRefundToEarning.mockImplementation(async (_p: string, r: string) => {
      if (r !== 'r-100') throw new Error('persistent failure');
    });
    const now = new Date('2026-10-15T10:00:00Z');
    expect(await svc.sweep(now)).toMatchObject({ checked: 100, failed: 100 });
    const restarted = new RefundReversalSweepService(prisma as never, payments as never, metrics as never, audit as never);
    expect(await restarted.sweep(new Date(now.getTime() + 5 * MIN))).toEqual({ checked: 1, applied: 1, failed: 0 });
    expect(payments.applyRefundToEarning).toHaveBeenLastCalledWith('p-100', 'r-100', 1500);
  });

  it('cada fallo espera más: 10, 20, 40… min hasta 12 h; guarda el motivo y el número de intentos', async () => {
    expect([1, 2, 3, 4, 5].map(nextRetryDelayMs)).toEqual([10, 20, 40, 80, 160].map((m) => m * MIN));
    expect(nextRetryDelayMs(20)).toBe(12 * 60 * MIN);
    const { svc, payments, rows } = make([rowA]);
    payments.applyRefundToEarning.mockRejectedValue(new Error('earning bloqueado'));
    let now = new Date('2026-10-15T10:00:00Z');
    for (const expectedWait of [10, 20, 40]) {
      await svc.sweep(now);
      const r = rows.get('r-a')!;
      expect(r.retryAt!.getTime() - now.getTime()).toBe(expectedWait * MIN);
      expect(r.lastError).toBe('earning bloqueado');
      // Antes de su hora no se vuelve a intentar.
      await svc.sweep(new Date(r.retryAt!.getTime() - 1));
      now = r.retryAt!;
    }
    expect(rows.get('r-a')!.attempts).toBe(3);
    expect(payments.applyRefundToEarning).toHaveBeenCalledTimes(3);
  });

  it('al fallo número NEEDS_HUMAN_AFTER_ATTEMPTS sale en Incidencias con el motivo, una sola vez', async () => {
    const { svc, payments, audit, rows } = make([{ ...rowA, attempts: NEEDS_HUMAN_AFTER_ATTEMPTS - 2 }]);
    payments.applyRefundToEarning.mockRejectedValue(new Error('la chica ya no tiene ganancia en este cobro'));
    let now = new Date('2026-10-15T10:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      await svc.sweep(now);
      now = rows.get('r-a')!.retryAt!;
    }
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'refund.earning_reverse_failed',
        tenantId: 't-1',
        targetId: 'p-a',
        payload: expect.objectContaining({
          refundId: 'r-a',
          attempts: NEEDS_HUMAN_AFTER_ATTEMPTS,
          needsHuman: true,
          error: 'la chica ya no tiene ganancia en este cobro',
        }),
      }),
    );
  });

  it('si otra réplica ya contó este intento, no lo cuenta otra vez ni avisa', async () => {
    const { svc, payments, audit, tx } = make([{ ...rowA, attempts: NEEDS_HUMAN_AFTER_ATTEMPTS - 1 }]);
    payments.applyRefundToEarning.mockRejectedValue(new Error('x'));
    tx.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.sweep(new Date('2026-10-15T10:00:00Z'));
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('si el aviso falla, el repaso sigue con las demás', async () => {
    const { svc, payments, audit } = make([{ ...rowA, attempts: NEEDS_HUMAN_AFTER_ATTEMPTS - 1 }, rowB]);
    payments.applyRefundToEarning.mockRejectedValueOnce(new Error('x'));
    audit.log.mockRejectedValueOnce(new Error('audit caído'));
    await expect(svc.sweep(new Date('2026-10-15T10:00:00Z'))).resolves.toEqual({ checked: 2, applied: 1, failed: 1 });
  });

  it('backlog: todo lo pendiente (también lo diferido), su antigüedad y lo que necesita a una persona', async () => {
    const { svc, tx } = make([]);
    tx.$queryRaw.mockResolvedValueOnce([{ pending: 101n, oldestAgeSeconds: 10_800.5, needsHuman: 2n }]);
    await expect(svc.backlog()).resolves.toEqual({ pending: 101, oldestAgeSeconds: 10_800.5, needsHuman: 2 });
    tx.$queryRaw.mockResolvedValueOnce([{ pending: 0n, oldestAgeSeconds: null, needsHuman: 0n }]);
    await expect(svc.backlog()).resolves.toEqual({ pending: 0, oldestAgeSeconds: 0, needsHuman: 0 });
  });

  it('cada devolución hecha sin descuento → applyRefundToEarning (idempotente por refundId)', async () => {
    const { svc, payments } = make([rowA, rowB]);
    const res = await svc.sweep(new Date('2026-10-15T10:00:00Z'));
    expect(payments.applyRefundToEarning).toHaveBeenCalledWith('p-a', 'r-a', 1500);
    expect(payments.applyRefundToEarning).toHaveBeenCalledWith('p-b', 'r-b', 900);
    expect(res).toEqual({ checked: 2, applied: 2, failed: 0 });
  });

  it('busca SUCCEEDED con earning y sin fila en earning_reversals, con margen y en lotes', async () => {
    const { svc, sqls, params } = make([]);
    const now = new Date('2026-10-15T10:00:00Z');
    await svc.sweep(now);
    const sql = sqls[0]!;
    expect(sql).toMatch(/status = 'SUCCEEDED'/);
    // Con ganancia en el cobro (puede haber varias: invitación): una vez por devolución.
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM operator_earnings/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*earning_reversals/);
    expect(sql).toMatch(/LIMIT/);
    const cutoff = params[0]![0] as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - 2 * 60 * 1000);
  });

  it('una que falla no para las demás: métrica + error, y se reintentará en el siguiente repaso', async () => {
    const { svc, payments, metrics } = make([rowA, rowB]);
    payments.applyRefundToEarning.mockRejectedValueOnce(new Error('deadlock detected'));
    const res = await svc.sweep();
    expect(res).toEqual({ checked: 2, applied: 1, failed: 1 });
    expect(metrics.earningReversalFailed.inc).toHaveBeenCalledWith({ venue: 't-1' });
    expect(payments.applyRefundToEarning).toHaveBeenCalledTimes(2);
  });

  it('si tras llamar sigue sin fila (no vio el earning) cuenta como fallo, no como hecho', async () => {
    const { svc, metrics } = make([rowA], ['r-a']);
    const res = await svc.sweep();
    expect(res).toEqual({ checked: 1, applied: 0, failed: 1 });
    expect(metrics.earningReversalFailed.inc).toHaveBeenCalled();
  });

  it('nada pendiente → no llama a nada', async () => {
    const { svc, payments } = make([]);
    expect(await svc.sweep()).toEqual({ checked: 0, applied: 0, failed: 0 });
    expect(payments.applyRefundToEarning).not.toHaveBeenCalled();
  });
});

describe('RefundReversalSweepService — arranque y cada 10 minutos', () => {
  const env = { ...process.env };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...env };
  });

  it('en producción: un repaso al arrancar y luego cada 10 min', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NIGHTPAY_DISABLE_REFUND_SWEEP;
    const { svc, prisma } = make([]);
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prisma.asSystem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(prisma.asSystem).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(prisma.asSystem).toHaveBeenCalledTimes(2);
  });

  it('en tests o con NIGHTPAY_DISABLE_REFUND_SWEEP=1 no se programa', async () => {
    process.env.NODE_ENV = 'production';
    process.env.NIGHTPAY_DISABLE_REFUND_SWEEP = '1';
    const off = make([]);
    off.svc.onModuleInit();
    process.env.NODE_ENV = 'test';
    delete process.env.NIGHTPAY_DISABLE_REFUND_SWEEP;
    const test = make([]);
    test.svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(off.prisma.asSystem).not.toHaveBeenCalled();
    expect(test.prisma.asSystem).not.toHaveBeenCalled();
  });

  it('si el repaso entero falla, solo se registra (no tumba el proceso)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NIGHTPAY_DISABLE_REFUND_SWEEP;
    const { svc, prisma } = make([]);
    prisma.asSystem.mockRejectedValueOnce(new Error('db down'));
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prisma.asSystem).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });
});
