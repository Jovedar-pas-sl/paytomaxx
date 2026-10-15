import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';

/**
 * applyRefundToEarning: si la comisión ya se pagó a la chica, la devolución
 * no toca el earning (refleja lo pagado) y queda como deuda
 * (earning_reversals.afterPayout) para descontarla del siguiente pago.
 */
function makeService(
  earning: { payoutId: string | null; reversedCents?: number; tipCents?: number },
  priorDebtCents = 0,
) {
  const queryRaw = vi
    .fn()
    // 0. idempotencia: este refund no se ha aplicado
    .mockResolvedValueOnce([])
    // 1. earning bloqueado
    .mockResolvedValueOnce([
      {
        id: 'earning-1',
        tenantId: 'tenant-1',
        commissionBps: 9000,
        commissionCents: 9000,
        tipCents: earning.tipCents ?? 0,
        reversedCents: earning.reversedCents ?? 0,
        // 100 € de servicio + la propina
        chargedCents: 10000 + (earning.tipCents ?? 0),
        payoutId: earning.payoutId,
      },
    ])
    // 2. refunds anteriores
    .mockResolvedValueOnce([{ total: 0n }])
    // 3. deuda ya registrada para este earning
    .mockResolvedValueOnce([{ total: BigInt(priorDebtCents) }]);
  const executeRaw = vi.fn().mockResolvedValue(1);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  // asSystem: la transacción con el bypass de RLS (operator_earnings con RLS forzado).
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };

  const service = Object.create(PaymentsService.prototype) as PaymentsService;
  Object.assign(service, {
    prisma,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, executeRaw };
}

function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

describe('applyRefundToEarning — devolución después de pagar a la chica', () => {
  it('earning sin pagar: descuenta del earning como siempre', async () => {
    const { service, executeRaw } = makeService({ payoutId: null });

    await service.applyRefundToEarning('payment-1', 'refund-1', 10000);

    const sqls = executeRaw.mock.calls.map(sqlOf);
    expect(sqls.some((q) => q.includes('UPDATE operator_earnings'))).toBe(true);
    const insert = executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    // valores: tenantId, earningId, refundId, delta, afterPayout
    expect(insert.slice(1)).toEqual(['tenant-1', 'earning-1', 'refund-1', 9000, false]);
  });

  it('earning ya pagado: NO toca el earning y deja la deuda para el siguiente pago', async () => {
    const { service, executeRaw } = makeService({ payoutId: 'payout-1' });

    await service.applyRefundToEarning('payment-1', 'refund-1', 10000);

    const sqls = executeRaw.mock.calls.map(sqlOf);
    expect(sqls.some((q) => q.includes('UPDATE operator_earnings'))).toBe(false);
    const insert = executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    expect(insert.slice(1)).toEqual(['tenant-1', 'earning-1', 'refund-1', 9000, true]);
  });

  it('con propina: la devolución total le quita comisión y propina (decisión del dueño)', async () => {
    const { service, executeRaw } = makeService({ payoutId: null, tipCents: 1000 });

    await service.applyRefundToEarning('payment-1', 'refund-1', 11000);

    const insert = executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    expect(insert.slice(1)).toEqual(['tenant-1', 'earning-1', 'refund-1', 10000, false]);
  });

  it('con propina y ya pagada: la propina también queda como deuda', async () => {
    const { service, executeRaw } = makeService({ payoutId: 'payout-1', tipCents: 1000 });

    await service.applyRefundToEarning('payment-1', 'refund-1', 5500);

    const insert = executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    // la mitad de lo cobrado → la mitad de 90 € + 10 €
    expect(insert.slice(1)).toEqual(['tenant-1', 'earning-1', 'refund-1', 5000, true]);
  });

  it('no cuenta dos veces la deuda ya registrada (devolución parcial en dos pasos)', async () => {
    // Primera devolución de 50 € ya dejó 45 € de deuda; ahora se devuelven otros 50 €.
    const { service, executeRaw } = makeService({ payoutId: 'payout-1' }, 4500);

    await service.applyRefundToEarning('payment-1', 'refund-2', 5000);

    const insert = executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    // acumulado devuelto 50 € (los refunds anteriores no están SUCCEEDED en el mock) → 45 € esperado,
    // ya hay 45 € de deuda → delta 0, no se crea deuda nueva.
    expect(insert.slice(1)).toEqual(['tenant-1', 'earning-1', 'refund-2', 0, false]);
  });
});
