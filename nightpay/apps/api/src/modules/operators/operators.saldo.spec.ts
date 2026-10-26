import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { OperatorsService } from './operators.service';

// Sala Bambú (Madrid) y Lucía Fernández, una de sus chicas.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OPERATOR = 'a1c3e5f7-2b4d-4e6f-8a0b-9c8d7e6f5a4b';
const OPERATOR_2 = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const DAY_MS = 24 * 3600 * 1000;
/** Cierre de la noche en Madrid: 05:30 del sábado 17 (03:30 UTC). */
const NOW = new Date('2026-10-17T05:30:00+02:00');

interface BalanceRow {
  pendingCents: bigint;
  heldCents: bigint;
  paidCents: bigint;
  lifetimeGrossCents: bigint;
  count: bigint;
}

const EMPTY_BALANCE: BalanceRow = { pendingCents: 0n, heldCents: 0n, paidCents: 0n, lifetimeGrossCents: 0n, count: 0n };

interface Opts {
  balances?: Record<string, BalanceRow>;
  debts?: Record<string, bigint>;
  /** Sin fila de deuda (COALESCE no llega): la consulta devuelve []. */
  debtRowsEmpty?: boolean;
  venueHoldDays?: number | null;
  envHoldDays?: unknown;
  /** La chica existe en este local (findFirst). */
  operatorInVenue?: boolean;
  earnings?: unknown[];
  payouts?: unknown[];
}

function makeService(opts: Opts = {}) {
  const queries: Prisma.Sql[] = [];
  const idIn = (q: Prisma.Sql) => (q.values.includes(OPERATOR_2) ? OPERATOR_2 : OPERATOR);
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      queries.push(q);
      if (q.text.includes('AS "heldCents"')) return [opts.balances?.[idIn(q)] ?? EMPTY_BALANCE];
      if (q.text.includes('FROM earning_reversals r')) {
        return opts.debtRowsEmpty ? [] : [{ total: opts.debts?.[idIn(q)] ?? 0n }];
      }
      if (q.text.includes('LEFT JOIN payments p')) return opts.earnings ?? [];
      if (q.text.includes('FROM operator_payouts po')) return opts.payouts ?? [];
      return [];
    }),
    venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: opts.venueHoldDays ?? null }) },
    user: {
      findFirst: vi.fn().mockResolvedValue(opts.operatorInVenue === false ? null : { id: OPERATOR }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    withTenant: vi.fn(),
  };
  prisma.withTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma));
  const config = { get: vi.fn((k: string) => (k === 'PAYOUT_HOLD_DAYS' ? opts.envHoldDays : undefined)) };
  const svc = new OperatorsService(
    prisma as never,
    {} as never,
    { log: vi.fn() } as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma, queries };
}

/** La consulta filtra por el local (parámetro, no el middleware) y por la chica. */
function expectScoped(q: Prisma.Sql, column: string): void {
  expect(q.text).toContain(`${column} = $`);
  expect(q.values).toContain(TENANT);
  expect(q.values).toContain(OPERATOR);
}

function cutoffOf(queries: Prisma.Sql[]): Date {
  const q = queries.find((x) => x.text.includes('AS "heldCents"'))!;
  return q.values.find((v): v is Date => v instanceof Date)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorsService.getBalance — saldo de la chica', () => {
  it('separa lo que sigue en espera de lo disponible y descuenta la deuda por devoluciones', async () => {
    const { svc } = makeService({
      balances: {
        [OPERATOR]: { pendingCents: 25_000n, heldCents: 6_000n, paidCents: 40_000n, lifetimeGrossCents: 300_000n, count: 12n },
      },
      debts: { [OPERATOR]: 2_500n },
    });
    expect(await svc.getBalance(OPERATOR, TENANT)).toEqual({
      pendingCents: 22_500,
      availableCents: 16_500,
      heldCents: 6_000,
      debtCents: 2_500,
      paidCents: 40_000,
      lifetimeGrossCents: 300_000,
      count: 12,
    });
  });

  it('un "en espera" negativo (devolución de algo aún retenido) cuenta 0 y no infla lo disponible', async () => {
    const { svc } = makeService({
      balances: { [OPERATOR]: { ...EMPTY_BALANCE, pendingCents: 5_000n, heldCents: -1_200n, count: 3n } },
    });
    const b = await svc.getBalance(OPERATOR, TENANT);
    expect(b.heldCents).toBe(0);
    expect(b.availableCents).toBe(5_000);
  });

  it('lo pagado nunca sale negativo aunque haya devoluciones tras pagar', async () => {
    const { svc } = makeService({ balances: { [OPERATOR]: { ...EMPTY_BALANCE, paidCents: -300n } } });
    expect((await svc.getBalance(OPERATOR, TENANT)).paidCents).toBe(0);
  });

  it('deuda mayor que lo pendiente: disponible negativo (no hay nada que pagarle)', async () => {
    const { svc } = makeService({
      balances: { [OPERATOR]: { ...EMPTY_BALANCE, pendingCents: 3_000n, count: 1n } },
      debts: { [OPERATOR]: 9_000n },
    });
    const b = await svc.getBalance(OPERATOR, TENANT);
    expect(b.availableCents).toBe(-6_000);
    expect(b.pendingCents).toBe(-6_000);
    expect(b.debtCents).toBe(9_000);
  });

  it('sin cobros ni deuda: todo a cero', async () => {
    const { svc } = makeService({ debtRowsEmpty: true });
    expect(await svc.getBalance(OPERATOR, TENANT)).toEqual({
      pendingCents: 0,
      availableCents: 0,
      heldCents: 0,
      debtCents: 0,
      paidCents: 0,
      lifetimeGrossCents: 0,
      count: 0,
    });
  });

  it('local con 0 días: el corte es ahora (lo de la noche se libera al cierre)', async () => {
    const { svc, queries, prisma } = makeService({ venueHoldDays: 0, envHoldDays: '7' });
    await svc.getBalance(OPERATOR, TENANT);
    expect(cutoffOf(queries).toISOString()).toBe(NOW.toISOString());
    expect(prisma.venue.findUnique).toHaveBeenCalledWith({ where: { id: TENANT }, select: { payoutHoldDays: true } });
  });

  it('sin regla del local ni PAYOUT_HOLD_DAYS: 7 días de espera', async () => {
    const { svc, queries } = makeService({ venueHoldDays: null });
    await svc.getBalance(OPERATOR, TENANT);
    expect(cutoffOf(queries).toISOString()).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
  });

  it('la regla del local (2 días) manda sobre PAYOUT_HOLD_DAYS (5)', async () => {
    const { svc, queries } = makeService({ venueHoldDays: 2, envHoldDays: '5' });
    await svc.getBalance(OPERATOR, TENANT);
    expect(cutoffOf(queries).toISOString()).toBe(new Date(NOW.getTime() - 2 * DAY_MS).toISOString());
  });

  it('PAYOUT_HOLD_DAYS ilegible: 7 días', async () => {
    const { svc, queries } = makeService({ envHoldDays: 'una semana' });
    await svc.getBalance(OPERATOR, TENANT);
    expect(cutoffOf(queries).getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it('las dos consultas (saldo y deuda) van filtradas por el local, con el local en la sesión', async () => {
    const { svc, queries, prisma } = makeService();
    await svc.getBalance(OPERATOR, TENANT);
    expect(queries).toHaveLength(2);
    expectScoped(queries[0]!, '"tenantId"');
    expectScoped(queries[1]!, 'e."tenantId"');
    expect(queries[1]!.text).toContain('r."settledPayoutId" IS NULL');
    expect(prisma.withTenant.mock.calls.map((c) => c[0])).toEqual([TENANT, TENANT]);
  });
});

describe('Autoservicio de la chica — nunca lee otro local', () => {
  it('sus comisiones: neto = comisión + propina − devuelto, filtradas por el local', async () => {
    const { svc, queries } = makeService({
      earnings: [
        {
          id: 'e0a1b2c3-0000-4000-8000-000000000001',
          paymentId: 'p0a1b2c3-0000-4000-8000-000000000001',
          consumptionId: null,
          paymentAmountCents: 15_000,
          commissionBps: 6_000,
          commissionCents: 9_000,
          tipCents: 500,
          reversedCents: 1_500,
          payoutId: null,
          paymentStatus: 'PARTIALLY_REFUNDED',
          createdAt: new Date('2026-10-17T01:12:00+02:00'),
        },
      ],
    });
    const [e] = await svc.getMyEarnings(OPERATOR, TENANT);
    expect(e).toMatchObject({ netCents: 8_000, tipCents: 500, payoutId: null, createdAt: '2026-10-16T23:12:00.000Z' });
    expectScoped(queries[0]!, 'e."tenantId"');
    expect(queries[0]!.values).toContain(50);
  });

  it('sus cobros: solo los suyos y del local, los 50 últimos', async () => {
    const { svc, prisma } = makeService();
    await svc.getMyPayments(OPERATOR, TENANT);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdByUserId: OPERATOR, tenantId: TENANT }, take: 50, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('sus pagos: cuántas comisiones lleva cada uno y fechas en ISO, filtrados por el local', async () => {
    const { svc, queries } = makeService({
      payouts: [
        {
          id: 'f1e2d3c4-0000-4000-8000-000000000001',
          totalCents: 48_000,
          paidByEmail: 'javier@salabambu.es',
          notes: 'Semana del 5 al 11',
          earningCount: 14n,
          createdAt: new Date('2026-10-12T18:00:00+02:00'),
          externalTxId: 'ES-TRF-20261012-01',
          externalRail: null,
          reconciliationStatus: 'MANUAL_OK',
          receiptUrl: null,
          reconciledAt: null,
        },
      ],
    });
    const [p] = await svc.getMyPayouts(OPERATOR, TENANT, 10);
    expect(p).toMatchObject({
      totalCents: 48_000,
      earningCount: 14,
      createdAt: '2026-10-12T16:00:00.000Z',
      externalRail: null,
      reconciliationStatus: 'MANUAL_OK',
      reconciledAt: null,
    });
    expectScoped(queries[0]!, 'po."tenantId"');
    expect(queries[0]!.values).toContain(10);
  });
});

describe('Panel del local — comisiones y pagos de una chica (anti-IDOR)', () => {
  it('chica de otro local: 404 en comisiones y pagos, sin leer nada', async () => {
    const { svc, prisma } = makeService({ operatorInVenue: false });
    await expect(svc.listOperatorEarnings(TENANT, OPERATOR)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.listOperatorPayouts(TENANT, OPERATOR)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: OPERATOR, tenantId: TENANT, role: { in: ['OPERATOR', 'WAITER'] } },
      select: { id: true },
    });
  });

  it('chica del local: sus comisiones, las 100 últimas, con el local en la consulta', async () => {
    const { svc, queries } = makeService();
    await svc.listOperatorEarnings(TENANT, OPERATOR);
    expectScoped(queries[0]!, 'e."tenantId"');
    expect(queries[0]!.values).toContain(100);
  });

  it('chica del local: sus pagos, los 100 últimos, con el local en la consulta', async () => {
    const { svc, queries } = makeService();
    await svc.listOperatorPayouts(TENANT, OPERATOR);
    expectScoped(queries[0]!, 'po."tenantId"');
    expect(queries[0]!.values).toContain(100);
  });
});

describe('OperatorsService.listVenueOperators — chicas activas con su saldo', () => {
  it('cada chica del local con su propio saldo y sin datos internos', async () => {
    const { svc, prisma } = makeService({
      balances: {
        [OPERATOR]: { ...EMPTY_BALANCE, pendingCents: 12_000n, heldCents: 3_000n, count: 4n },
        [OPERATOR_2]: { ...EMPTY_BALANCE, pendingCents: 1_000n, count: 1n },
      },
      debts: { [OPERATOR_2]: 4_000n },
    });
    const row = (id: string, displayName: string) => ({
      id,
      email: `${displayName.toLowerCase()}@salabambu.es`,
      displayName,
      commissionBps: null,
      deletedAt: null,
      invitedAt: null,
      createdAt: new Date('2026-09-01T20:00:00+02:00'),
      passwordHash: '$2a$10$secreto',
      inviteToken: 'hash-de-invitacion',
    });
    prisma.user.findMany.mockResolvedValue([row(OPERATOR, 'Lucía'), row(OPERATOR_2, 'Carmen')]);

    const list = await svc.listVenueOperators(TENANT);

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, role: 'OPERATOR', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(list.map((o) => [o.displayName, o.balance.availableCents])).toEqual([
      ['Lucía', 9_000],
      ['Carmen', -3_000],
    ]);
    expect(list[0]).not.toHaveProperty('passwordHash');
    expect(list[0]).not.toHaveProperty('inviteToken');
    expect(list[0]).toMatchObject({ active: true, commissionBps: 0 });
  });
});

describe('los camareros: su parte de las invitaciones se ve y se paga como la de las chicas', () => {
  it('?role=WAITER: los camareros activos del local con su saldo', async () => {
    const { svc, prisma } = makeService({ balances: { [OPERATOR]: { ...EMPTY_BALANCE, pendingCents: 500n, count: 2n } } });
    prisma.user.findMany.mockResolvedValue([
      { id: OPERATOR, email: 'pepe@salabambu.es', displayName: 'Pepe', commissionBps: null, deletedAt: null, invitedAt: null, createdAt: new Date('2026-09-01T20:00:00+02:00') },
    ]);
    const list = await svc.listVenueOperators(TENANT, 'WAITER');
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, role: 'WAITER', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(list.map((o) => [o.displayName, o.balance.pendingCents, o.balance.count])).toEqual([['Pepe', 500, 2]]);
  });

  it('sus comisiones y sus pagos se leen igual (el anti-IDOR admite chica o camarero del local)', async () => {
    const { svc, queries } = makeService();
    await svc.listOperatorEarnings(TENANT, OPERATOR);
    await svc.listOperatorPayouts(TENANT, OPERATOR);
    expectScoped(queries[0]!, 'e."tenantId"');
    expectScoped(queries[1]!, 'po."tenantId"');
  });
});

describe('OperatorsService.ensureBelongsToVenue', () => {
  it('chica de otro local → 403', async () => {
    const { svc } = makeService({ operatorInVenue: false });
    await expect(svc.ensureBelongsToVenue(OPERATOR, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chica del local → pasa (se busca con el local y el rol)', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.ensureBelongsToVenue(OPERATOR, TENANT)).resolves.toBeUndefined();
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: OPERATOR, tenantId: TENANT, role: { in: ['OPERATOR', 'WAITER'] } },
      select: { id: true },
    });
  });
});
