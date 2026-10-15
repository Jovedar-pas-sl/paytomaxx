import { describe, it, expect, vi } from 'vitest';
import { TreasuryService } from './treasury.service';

interface Opts {
  balances?: Array<{ operatorId: string; unpaidCents: bigint; heldCents: bigint; debtCents: bigint }>;
  holdDays?: string;
}

function makeTreasury(opts: Opts = {}) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const prisma = {
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(values);
      if (sql.includes('operator_earnings')) return opts.balances ?? [];
      if (sql.includes('GROUP BY "externalRail"')) return [{ rail: 'USDT_TRC20', count: 2n }];
      if (sql.includes('GROUP BY "reconciliationStatus"')) return [{ status: 'MATCHED', count: 2n }];
      return [{ count: 2n, totalCents: 15_000n }];
    }),
  };
  const config = { get: vi.fn((k: string) => (k === 'PAYOUT_HOLD_DAYS' ? opts.holdDays : undefined)) };
  const svc = new TreasuryService(prisma as never, { log: vi.fn() } as never, {} as never, config as never);
  return { svc, sqls, params };
}

describe('TreasuryService.getStats — pendiente a chicas = lo que hay que pagar ya', () => {
  it('como el saldo de cada chica: con propinas, sin lo que está en espera y menos su deuda', async () => {
    const { svc } = makeTreasury({
      balances: [
        { operatorId: 'a', unpaidCents: 12_000n, heldCents: 3_000n, debtCents: 1_000n },
        { operatorId: 'b', unpaidCents: 1_000n, heldCents: 0n, debtCents: 9_000n },
        { operatorId: 'c', unpaidCents: 4_000n, heldCents: 4_000n, debtCents: 0n },
      ],
    });
    const stats = await svc.getStats('t-1');
    expect(stats).toMatchObject({
      pendingPayoutsCents: 8_000,
      pendingOperatorCount: 1,
      heldPayoutsCents: 7_000,
      operatorDebtCents: 10_000,
      payoutsThisMonthCount: 2,
      payoutsThisMonthCents: 15_000,
    });
  });

  it('la consulta suma propinas, separa lo que está en espera con el corte de PAYOUT_HOLD_DAYS y lee la deuda abierta', async () => {
    const { svc, sqls, params } = makeTreasury({ holdDays: '3' });
    const before = Date.now();
    await svc.getStats('t-1');
    const i = sqls.findIndex((s) => s.includes('operator_earnings'));
    const sql = sqls[i]!;
    expect(sql).toMatch(/COALESCE\("tipCents", ?0\)/);
    expect(sql).toMatch(/"payoutId" IS NULL/);
    expect(sql).toMatch(/earning_reversals/);
    expect(sql).toMatch(/"afterPayout"/);
    expect(sql).toMatch(/"settledPayoutId" IS NULL/);
    const cutoff = params[i]!.find((v): v is Date => v instanceof Date)!;
    const expected = before - 3 * 24 * 3600 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
  });

  it('sin chicas → todo a cero', async () => {
    const { svc } = makeTreasury();
    expect(await svc.getStats('t-1')).toMatchObject({ pendingPayoutsCents: 0, pendingOperatorCount: 0 });
  });
});
