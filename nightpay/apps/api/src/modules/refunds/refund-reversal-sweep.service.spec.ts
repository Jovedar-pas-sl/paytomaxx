import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefundReversalSweepService } from './refund-reversal-sweep.service';

interface Missing {
  refundId: string;
  paymentId: string;
  tenantId: string;
  amountCents: number;
}

const rowA: Missing = { refundId: 'r-a', paymentId: 'p-a', tenantId: 't-1', amountCents: 1500 };
const rowB: Missing = { refundId: 'r-b', paymentId: 'p-b', tenantId: 't-2', amountCents: 900 };

function make(missing: Missing[], stillMissingAfter: string[] = []) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(values);
      if (sql.includes('LIMIT')) return missing;
      // Comprobación posterior: ¿ya hay fila en earning_reversals?
      const refundId = values[0] as string;
      return stillMissingAfter.includes(refundId) ? [] : [{ ok: 1 }];
    }),
  };
  const prisma = { asSystem: vi.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const payments = { applyRefundToEarning: vi.fn().mockResolvedValue(undefined) };
  const metrics = { earningReversalFailed: { inc: vi.fn() } };
  const svc = new RefundReversalSweepService(prisma as never, payments as never, metrics as never);
  return { svc, prisma, payments, metrics, sqls, params };
}

describe('RefundReversalSweepService.sweep — reintenta el descuento a la chica', () => {
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
    expect(sql).toMatch(/JOIN operator_earnings/);
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
    expect(metrics.earningReversalFailed.inc).toHaveBeenCalledWith({ venue: 't-1', payment_id: 'p-a' });
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
