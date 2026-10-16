import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreasuryService } from './treasury.service';

interface Opts {
  balances?: Array<{ operatorId: string; unpaidCents: bigint; heldCents: bigint; debtCents: bigint }>;
  holdDays?: string;
  /** venues.payoutHoldDays (regla del local; null = PAYOUT_HOLD_DAYS). */
  venueHoldDays?: number | null;
}

function makeTreasury(opts: Opts = {}) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const prisma = {
    venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: opts.venueHoldDays ?? null }) },
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(values);
      if (sql.includes('operator_earnings')) return opts.balances ?? [];
      if (sql.includes('GROUP BY "externalRail"')) return [{ rail: 'USDT_TRC20', count: 2n }];
      if (sql.includes('GROUP BY "reconciliationStatus"')) return [{ status: 'MATCHED', count: 2n }];
      return [{ count: 2n, totalCents: 15_000n }];
    }),
    withTenant: vi.fn(),
  };
  // Las lecturas de operator_earnings van con el local en la sesión (RLS forzado): misma consulta.
  prisma.withTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma));
  const config = { get: vi.fn((k: string) => (k === 'PAYOUT_HOLD_DAYS' ? opts.holdDays : undefined)) };
  const svc = new TreasuryService(prisma as never, { log: vi.fn() } as never, {} as never, config as never);
  return { svc, sqls, params, withTenant: prisma.withTenant };
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

  // Reloj fijo: el corte se compara exacto, sin márgenes que dependan de la máquina.
  const NOW = new Date('2026-10-17T03:30:00Z');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('la consulta suma propinas, separa lo que está en espera con el corte de PAYOUT_HOLD_DAYS y lee la deuda abierta', async () => {
    const { svc, sqls, params } = makeTreasury({ holdDays: '3' });
    await svc.getStats('t-1');
    const i = sqls.findIndex((s) => s.includes('operator_earnings'));
    const sql = sqls[i]!;
    expect(sql).toMatch(/COALESCE\("tipCents", ?0\)/);
    expect(sql).toMatch(/"payoutId" IS NULL/);
    expect(sql).toMatch(/earning_reversals/);
    expect(sql).toMatch(/"afterPayout"/);
    expect(sql).toMatch(/"settledPayoutId" IS NULL/);
    const cutoff = params[i]!.find((v): v is Date => v instanceof Date)!;
    expect(cutoff).toEqual(new Date('2026-10-14T03:30:00Z'));
  });

  it('con días de espera del local, mandan los del local (0 = todo se puede pagar ya), no PAYOUT_HOLD_DAYS', async () => {
    const { svc, sqls, params } = makeTreasury({ holdDays: '3', venueHoldDays: 0 });
    await svc.getStats('t-1');
    const i = sqls.findIndex((s) => s.includes('operator_earnings'));
    const cutoff = params[i]!.find((v): v is Date => v instanceof Date)!;
    expect(cutoff).toEqual(NOW);
  });

  it('todas las consultas van con el local en la sesión y filtradas por el local', async () => {
    const { svc, sqls, params, withTenant } = makeTreasury();
    await svc.getStats('t-1');
    expect(sqls.length).toBeGreaterThan(0);
    expect(withTenant.mock.calls.map((c) => c[0])).toEqual(sqls.map(() => 't-1'));
    sqls.forEach((sql, i) => {
      expect(sql).toMatch(/"tenantId" = \?/);
      expect(params[i]).toContain('t-1');
    });
  });

  it('sin chicas → todo a cero', async () => {
    const { svc } = makeTreasury();
    expect(await svc.getStats('t-1')).toMatchObject({ pendingPayoutsCents: 0, pendingOperatorCount: 0 });
  });
});

// ─── Verificación de pagos cripto ───────────────────────────────────

const TRON_TO = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';

interface VerifyOpts {
  /** Otro pago del local con el mismo hash. */
  otherWithTx?: { id: string; createdAt: Date } | null;
  verifierResult?: Record<string, unknown>;
  updateError?: Error;
  payout?: Record<string, unknown>;
}

function makeVerify(opts: VerifyOpts = {}) {
  const payout = {
    id: 'po-1',
    tenantId: 't-1',
    totalCents: 10_000,
    createdAt: new Date('2026-10-14T12:00:00Z'),
    reconciliationStatus: 'UNRECONCILED',
    externalTxId: null,
    externalRail: 'USDT_TRC20',
    expectedAmountUsdt: { toString: () => '107' },
    payoutFxRate: { toString: () => '1.07' },
    reconciledAt: null,
    operator: { id: 'op-1', email: 'c@x.es', tenantId: 't-1', payoutMethod: 'USDT_TRC20', payoutAddress: TRON_TO },
    ...(opts.payout ?? {}),
  };
  const tx = {
    operatorPayout: {
      findUnique: vi.fn().mockResolvedValue(payout),
      findFirst: vi.fn().mockResolvedValue(opts.otherWithTx ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      update: opts.updateError ? vi.fn().mockRejectedValue(opts.updateError) : vi.fn().mockResolvedValue(payout),
    },
  };
  const prisma = {
    asSystem: vi.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    withTenant: vi.fn().mockImplementation(async (_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
  };
  const verifier = {
    verify: vi.fn().mockResolvedValue(
      opts.verifierResult ?? {
        matched: true,
        status: 'MATCHED',
        occurredAt: new Date('2026-10-14T13:00:00Z'),
        actualAmountCents: null,
        actualAmountUsdt: 107,
        reason: null,
      },
    ),
  };
  const factory = { forMethod: vi.fn().mockReturnValue(verifier) };
  const audit = { log: vi.fn() };
  const svc = new TreasuryService(prisma as never, audit as never, factory as never, { get: vi.fn() } as never);
  return { svc, tx, verifier, audit };
}

const dto = { externalTxId: ' abcd1234ef ', externalRail: 'USDT_TRC20' as const };

describe('TreasuryService.verifyPayout — un hash on-chain verifica un solo pago', () => {
  it('el hash ya está en otro pago del local → 409 sin llamar al explorador ni guardar', async () => {
    const { svc, tx, verifier } = makeVerify({ otherWithTx: { id: 'po-0', createdAt: new Date('2026-10-01T10:00:00Z') } });
    await expect(svc.verifyPayout('t-1', 'po-1', 'u-owner', dto)).rejects.toThrow(/ya está apuntado en otro pago/);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
    expect(tx.operatorPayout.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't-1',
          id: { not: 'po-1' },
          externalTxId: { equals: 'abcd1234ef', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('a la vez (índice único) → 409 igualmente', async () => {
    const { svc } = makeVerify({ updateError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) });
    await expect(svc.verifyPayout('t-1', 'po-1', 'u-owner', dto)).rejects.toThrow(/ya está apuntado en otro pago/);
  });

  it('cuadra → MATCHED; devuelve lo recibido en USDT y en EUR con la foto del tipo del pago', async () => {
    const { svc, tx, verifier } = makeVerify();
    const res = await svc.verifyPayout('t-1', 'po-1', 'u-owner', dto);
    expect(res).toMatchObject({ matched: true, status: 'MATCHED', actualAmountUsdt: 107, actualAmountCents: 10_000 });
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ externalTxId: 'abcd1234ef', expectedToAddress: TRON_TO, expectedAmountUsdt: 107 }),
    );
    expect(tx.operatorPayout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ externalTxId: 'abcd1234ef', reconciliationStatus: 'MATCHED' }) }),
    );
  });

  it('transacción de más de 24 h antes del pago → MISMATCH con el motivo', async () => {
    const { svc, tx } = makeVerify({
      verifierResult: {
        matched: true,
        status: 'MATCHED',
        occurredAt: new Date('2026-10-01T10:00:00Z'),
        actualAmountCents: null,
        actualAmountUsdt: 107,
        reason: null,
      },
    });
    const res = await svc.verifyPayout('t-1', 'po-1', 'u-owner', dto);
    expect(res).toMatchObject({ matched: false, status: 'MISMATCH' });
    expect(res.reason).toMatch(/^tx_anterior_al_pago: /);
    expect(tx.operatorPayout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reconciliationStatus: 'MISMATCH' }) }),
    );
  });

  it('métodos manuales: el hash no se cruza (puede repetirse una referencia de efectivo)', async () => {
    const { svc, tx } = makeVerify({ otherWithTx: { id: 'po-0', createdAt: new Date() } });
    const res = await svc.verifyPayout('t-1', 'po-1', 'u-owner', { externalTxId: 'EFECTIVO', externalRail: 'MANUAL_CASH' });
    expect(res.status).toBe('UNRECONCILED');
    expect(tx.operatorPayout.findFirst).not.toHaveBeenCalled();
  });
});

describe('TreasuryService.reconcilePending — mismas reglas en el repaso', () => {
  it('no da por bueno un hash repetido ni una transacción vieja', async () => {
    const created = new Date('2026-10-14T12:00:00Z');
    const base = {
      tenantId: 't-1',
      totalCents: 10_000,
      createdAt: created,
      externalRail: 'USDT_TRC20',
      expectedAmountUsdt: null,
      operator: { payoutAddress: TRON_TO },
    };
    const { svc, tx, verifier } = makeVerify({
      verifierResult: {
        matched: true,
        status: 'MATCHED',
        occurredAt: new Date('2026-09-01T00:00:00Z'),
        actualAmountCents: null,
        actualAmountUsdt: 107,
        reason: null,
      },
    });
    tx.operatorPayout.findMany.mockResolvedValue([
      { ...base, id: 'po-dup', externalTxId: 'dup-hash' },
      { ...base, id: 'po-old', externalTxId: 'old-hash' },
    ]);
    tx.operatorPayout.findFirst.mockImplementation(async ({ where }: { where: { externalTxId: { equals: string } } }) =>
      where.externalTxId.equals === 'dup-hash' ? { id: 'po-x', createdAt: created } : null,
    );
    const res = await svc.reconcilePending('t-1');
    expect(res).toEqual({ checked: 2, matched: 0 });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
  });
});
