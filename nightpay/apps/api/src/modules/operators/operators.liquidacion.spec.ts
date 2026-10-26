import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { OperatorsService } from './operators.service';

// Sala Bambú (Madrid): el dueño, Javier Ortega, liquida a Lucía Fernández.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OPERATOR = 'a1c3e5f7-2b4d-4e6f-8a0b-9c8d7e6f5a4b';
const OWNER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PAYOUT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const E1 = 'e1000000-0000-4000-8000-000000000001';
const E2 = 'e1000000-0000-4000-8000-000000000002';
const R1 = 'r1000000-0000-4000-8000-000000000001';
const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date('2026-10-19T13:00:00+02:00');

interface Earning {
  id: string;
  commissionCents: number;
  tipCents: number;
  reversedCents: number;
}

interface Opts {
  payoutMethod?: string | null;
  payoutAddress?: string | null;
  operatorInVenue?: boolean;
  pending?: Earning[];
  debts?: Array<{ id: string; reversedDeltaCents: number }>;
  venueHoldDays?: number | null;
  fx?: { rate: number; degraded: boolean } | Error;
  otherWithTx?: { id: string; createdAt: Date } | null;
  createError?: Error;
}

const DEFAULT_PENDING: Earning[] = [
  { id: E1, commissionCents: 9_000, tipCents: 500, reversedCents: 0 },
  { id: E2, commissionCents: 4_500, tipCents: 0, reversedCents: 1_500 },
];

function makeService(opts: Opts = {}) {
  const queries: Prisma.Sql[] = [];
  const updates: Prisma.Sql[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      // El candado por chica (payout-selection) no es una lectura: no cuenta.
      if (q.text.includes('pg_advisory_xact_lock')) return [{ ok: 1 }];
      queries.push(q);
      if (q.text.includes('FROM earning_reversals r')) return opts.debts ?? [];
      return opts.pending ?? DEFAULT_PENDING;
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      updates.push(Prisma.sql(strings, ...values));
      return 1;
    }),
    operatorPayout: {
      findFirst: vi.fn().mockResolvedValue(opts.otherWithTx ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.createError) throw opts.createError;
        return { id: PAYOUT_ID, totalCents: data.totalCents, createdAt: new Date() };
      }),
    },
  };
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(
        opts.operatorInVenue === false
          ? null
          : {
              id: OPERATOR,
              payoutMethod: opts.payoutMethod === undefined ? 'MANUAL_CASH' : opts.payoutMethod,
              payoutAddress: opts.payoutAddress ?? null,
            },
      ),
    },
    venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: opts.venueHoldDays ?? null }) },
    withTenant: vi.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const fx = {
    getEurToUsdtRateInfo:
      opts.fx instanceof Error
        ? vi.fn().mockRejectedValue(opts.fx)
        : vi.fn().mockResolvedValue(opts.fx ?? { rate: 1.0825, degraded: false }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const svc = new OperatorsService(prisma as never, {} as never, audit as never, config as never, {} as never, fx as never, {} as never);
  /** Lo que se escribió en operator_payouts. */
  const created = () => tx.operatorPayout.create.mock.calls[0]![0].data;
  return { svc, prisma, tx, fx, audit, queries, updates, created };
}

/** Código del error de la API (p. ej. PAYOUT_TX_ALREADY_USED). */
async function errorOf(p: Promise<unknown>): Promise<{ err: unknown; body: Record<string, unknown> }> {
  const err = await p.then(
    () => {
      throw new Error('se esperaba un error');
    },
    (e: unknown) => e,
  );
  const body = err instanceof HttpException ? (err.getResponse() as Record<string, unknown>) : {};
  return { err, body };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorsService.createPayout (dueño) — importe y enlaces', () => {
  it('importe = comisiones liberadas (con propinas, menos lo devuelto) − deudas abiertas', async () => {
    const { svc, created } = makeService({ debts: [{ id: R1, reversedDeltaCents: 2_000 }] });
    const res = await svc.createPayout(TENANT, OPERATOR, OWNER, 'Liquidación semanal');
    expect(created()).toMatchObject({
      tenantId: TENANT,
      operatorId: OPERATOR,
      totalCents: 10_500,
      paidByUserId: OWNER,
      notes: 'Liquidación semanal',
    });
    expect(res).toEqual({ id: PAYOUT_ID, totalCents: 10_500, earningCount: 2, createdAt: NOW.toISOString() });
  });

  it('guarda en el pago la dirección de cobro que tenía la chica al pagarle: se verifica contra esa (DIN-6)', async () => {
    const tron = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
    const conDireccion = makeService({ payoutMethod: 'USDT_TRC20', payoutAddress: tron });
    await conDireccion.svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(conDireccion.created()).toMatchObject({ paidToAddress: tron });
    // Sin dirección guardada: '' («no tenía»), distinto de NULL (pagos de antes de guardarla).
    const sinDireccion = makeService({ payoutMethod: 'MANUAL_CASH', payoutAddress: null });
    await sinDireccion.svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(sinDireccion.created()).toMatchObject({ paidToAddress: '' });
  });

  it('las comisiones y las deudas quedan enlazadas a este pago', async () => {
    const { svc, updates } = makeService({ debts: [{ id: R1, reversedDeltaCents: 2_000 }] });
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.text).toContain('UPDATE operator_earnings');
    expect(updates[0]!.values).toEqual([PAYOUT_ID, [E1, E2]]);
    expect(updates[1]!.text).toContain('UPDATE earning_reversals');
    expect(updates[1]!.values).toEqual([PAYOUT_ID, [R1]]);
  });

  it('sin deudas abiertas no se toca earning_reversals', async () => {
    const { svc, updates } = makeService();
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(updates.map((u) => u.text.includes('earning_reversals'))).toEqual([false]);
  });

  it('solo entra lo que ya pasó la espera (7 días) y todo va filtrado por el local, con bloqueo', async () => {
    const { svc, queries, prisma } = makeService();
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    const [pending, debts] = queries;
    expect(pending!.text).toContain('"tenantId" = $');
    expect(pending!.text).toContain('FOR UPDATE');
    expect(pending!.values).toEqual([OPERATOR, TENANT, new Date(NOW.getTime() - 7 * DAY_MS)]);
    expect(debts!.text).toContain('e."tenantId" = $');
    expect(debts!.values).toEqual([OPERATOR, TENANT]);
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('nada liberado todavía (7 días) → 409 sin crear pago ni enlazar nada', async () => {
    const { svc, tx, updates, audit } = makeService({ pending: [] });
    const { err } = await errorOf(svc.createPayout(TENANT, OPERATOR, OWNER));
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/7 días/);
    expect(tx.operatorPayout.create).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['deuda mayor que lo liberado', 5_000],
    ['deuda igual a lo liberado (neto 0)', 3_000],
  ])('%s → 409 sin crear pago', async (_caso, debt) => {
    const { svc, tx, updates } = makeService({
      pending: [{ id: E1, commissionCents: 3_000, tipCents: 0, reversedCents: 0 }],
      debts: [{ id: R1, reversedDeltaCents: debt }],
    });
    await expect(svc.createPayout(TENANT, OPERATOR, OWNER)).rejects.toThrow(/deuda/);
    expect(tx.operatorPayout.create).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('chica de otro local → 404 sin abrir transacción', async () => {
    const { svc, prisma } = makeService({ operatorInVenue: false });
    await expect(svc.createPayout(TENANT, OPERATOR, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { id: OPERATOR, tenantId: TENANT, role: { in: ['OPERATOR', 'WAITER'] } } });
  });

  it('queda en el registro quién pagó, cuánto y cuántas comisiones', async () => {
    const { svc, audit } = makeService();
    await svc.createPayout(TENANT, OPERATOR, OWNER, 'Efectivo en caja');
    expect(audit.log).toHaveBeenCalledWith({
      action: 'operator.payout.created',
      tenantId: TENANT,
      actorId: OWNER,
      targetType: 'User',
      targetId: OPERATOR,
      payload: { payoutId: PAYOUT_ID, totalCents: 12_500, earningCount: 2, notes: 'Efectivo en caja' },
    });
  });
});

describe('OperatorsService.createPayout — rail y foto del tipo EUR→USDT', () => {
  it('rail cripto: congela el tipo y lo esperado en USDT', async () => {
    const { svc, created } = makeService({ payoutMethod: 'USDT_TRC20' });
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(created()).toMatchObject({
      externalRail: 'USDT_TRC20',
      totalCents: 12_500,
      payoutFxRate: '1.082500',
      expectedAmountUsdt: '135.312500',
    });
  });

  it.each(['USDT_BEP20', 'USDC_POLY', 'USDC_SOL', 'BINANCE_PAY_ID', 'OKX_INTERNAL', 'BYBIT_INTERNAL'])(
    '%s también lleva foto del tipo',
    async (rail) => {
      const { svc, created, fx } = makeService({ payoutMethod: rail });
      await svc.createPayout(TENANT, OPERATOR, OWNER);
      expect(fx.getEurToUsdtRateInfo).toHaveBeenCalledTimes(1);
      expect(created()).toMatchObject({ externalRail: rail, payoutFxRate: '1.082500' });
    },
  );

  it.each(['SEPA_IBAN', 'MANUAL_CASH', 'REVOLUT_TAG', 'PIX_KEY', 'FASTERPAY_EMAIL'])(
    '%s (fiat) va sin foto del tipo',
    async (rail) => {
      const { svc, created, fx } = makeService({ payoutMethod: rail });
      await svc.createPayout(TENANT, OPERATOR, OWNER);
      expect(fx.getEurToUsdtRateInfo).not.toHaveBeenCalled();
      expect(created()).toMatchObject({ externalRail: rail });
      expect(created()).not.toHaveProperty('payoutFxRate');
      expect(created()).not.toHaveProperty('expectedAmountUsdt');
    },
  );

  it('Binance caído (tipo degradado): se congela igualmente el de reserva', async () => {
    const { svc, created } = makeService({ payoutMethod: 'USDT_TRC20', fx: { rate: 1.07, degraded: true } });
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(created()).toMatchObject({ payoutFxRate: '1.070000', expectedAmountUsdt: '133.750000' });
  });

  it('si falla la consulta del tipo, el pago se crea igualmente sin foto', async () => {
    const { svc, created } = makeService({ payoutMethod: 'USDT_TRC20', fx: new Error('ETIMEDOUT') });
    const res = await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(res.totalCents).toBe(12_500);
    expect(created()).not.toHaveProperty('payoutFxRate');
  });

  it('el rail de la petición manda sobre el método preferido de la chica', async () => {
    const { svc, created, fx } = makeService({ payoutMethod: 'USDT_TRC20' });
    await svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { externalRail: 'MANUAL_CASH' });
    expect(created()).toMatchObject({ externalRail: 'MANUAL_CASH' });
    expect(fx.getEurToUsdtRateInfo).not.toHaveBeenCalled();
  });

  it('sin rail ni método preferido: el pago no lleva rail', async () => {
    const { svc, created } = makeService({ payoutMethod: null });
    await svc.createPayout(TENANT, OPERATOR, OWNER);
    expect(created()).not.toHaveProperty('externalRail');
  });

  it('hash y justificante se guardan en el pago', async () => {
    const { svc, created } = makeService({ payoutMethod: 'SEPA_IBAN' });
    await svc.createPayout(TENANT, OPERATOR, OWNER, undefined, {
      externalTxId: 'TRF-20261019-0042',
      receiptUrl: 'https://docs.salabambu.es/justificantes/0042.pdf',
    });
    expect(created()).toMatchObject({
      externalTxId: 'TRF-20261019-0042',
      receiptUrl: 'https://docs.salabambu.es/justificantes/0042.pdf',
    });
  });
});

describe('OperatorsService.createPayout — un hash on-chain, un solo pago', () => {
  const HASH = '7c3f9a1e5b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e';

  it('hash ya en otro pago (con el método preferido on-chain) → 409 PAYOUT_TX_ALREADY_USED', async () => {
    const other = { id: '3c4d5e6f-0000-4000-8000-000000000009', createdAt: new Date('2026-10-12T16:00:00Z') };
    const { svc, tx, queries } = makeService({ payoutMethod: 'USDT_TRC20', otherWithTx: other });
    const { err, body } = await errorOf(svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { externalTxId: ` ${HASH} ` }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(body).toMatchObject({ code: 'PAYOUT_TX_ALREADY_USED', payoutId: other.id });
    expect(tx.operatorPayout.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, externalTxId: { equals: HASH, mode: 'insensitive' } },
      select: { id: true, createdAt: true },
    });
    expect(queries).toHaveLength(0);
    expect(tx.operatorPayout.create).not.toHaveBeenCalled();
  });

  it('a la vez otro pago se queda el hash (P2002) → 409 PAYOUT_TX_ALREADY_USED y sin registro', async () => {
    const { svc, audit } = makeService({
      payoutMethod: 'USDT_TRC20',
      createError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    });
    const { err, body } = await errorOf(svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { externalTxId: HASH }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(body.code).toBe('PAYOUT_TX_ALREADY_USED');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('otro fallo de la base se propaga tal cual (no se disfraza de hash repetido)', async () => {
    const boom = new Error('Connection terminated unexpectedly');
    const { svc } = makeService({ createError: boom });
    await expect(svc.createPayout(TENANT, OPERATOR, OWNER)).rejects.toBe(boom);
  });
});

describe('OperatorsService.createPayout — la cifra que se vio y la Idempotency-Key', () => {
  const idem = { key: 'pago-0001-abcdef', hash: 'huella-1' };
  const withEarningCount = (h: ReturnType<typeof makeService>, n: number) => {
    (h.tx as unknown as Record<string, unknown>).operatorEarning = { count: vi.fn().mockResolvedValue(n) };
  };

  it('lo pagable es la cifra que vio quien paga → se paga; otra cifra → 409 PAYOUT_CHANGED sin apuntar nada', async () => {
    const ok = makeService();
    await expect(ok.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { expectedTotalCents: 12_500 })).resolves.toMatchObject({
      totalCents: 12_500,
    });
    const changed = makeService();
    const { err, body } = await errorOf(changed.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { expectedTotalCents: 10_000 }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(body).toMatchObject({ code: 'PAYOUT_CHANGED' });
    expect(String(body.message)).toContain('ahora son 125,00 €, no 100,00 €');
    expect(changed.tx.operatorPayout.create).not.toHaveBeenCalled();
    expect(changed.audit.log).not.toHaveBeenCalled();
  });

  it('con clave: se guarda en el pago con la huella de la petición', async () => {
    const h = makeService();
    await h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem });
    expect(h.created()).toMatchObject({ idempotencyKey: 'pago-0001-abcdef', idempotencyHash: 'huella-1' });
    expect(h.tx.operatorPayout.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, idempotencyKey: 'pago-0001-abcdef' } }),
    );
  });

  it('la misma clave y petición otra vez → el mismo pago, sin apuntar otro ni registrarlo', async () => {
    const h = makeService();
    withEarningCount(h, 2);
    const at = new Date('2026-10-19T10:00:00Z');
    h.tx.operatorPayout.findFirst.mockResolvedValueOnce({
      id: PAYOUT_ID, operatorId: OPERATOR, paidByUserId: OWNER, idempotencyHash: 'huella-1', totalCents: 12_500, createdAt: at,
    });
    await expect(h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem })).resolves.toEqual({
      id: PAYOUT_ID, totalCents: 12_500, earningCount: 2, createdAt: at.toISOString(),
    });
    expect(h.tx.operatorPayout.create).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('la misma clave con otra petición, otra chica u otra persona → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    for (const prior of [
      { operatorId: OPERATOR, paidByUserId: OWNER, idempotencyHash: 'otra' },
      { operatorId: 'otra-chica', paidByUserId: OWNER, idempotencyHash: 'huella-1' },
      { operatorId: OPERATOR, paidByUserId: 'otra-persona', idempotencyHash: 'huella-1' },
    ]) {
      const h = makeService();
      h.tx.operatorPayout.findFirst.mockResolvedValueOnce({ id: PAYOUT_ID, totalCents: 1, createdAt: NOW, ...prior });
      const { body } = await errorOf(h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem }));
      expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(h.tx.operatorPayout.create).not.toHaveBeenCalled();
    }
  });

  describe('a la vez otro pago con la misma clave (choque de único al apuntarlo)', () => {
    // Con FORCE RLS, Postgres esconde el detalle del índice y Prisma da «(not available)».
    const clash = () => Object.assign(new Error('Unique constraint failed on the (not available)'), { code: 'P2002', meta: { target: '(not available)' } });

    it('era la misma petición (ganó la otra): devuelve ese pago, sin apuntar otro ni registrarlo', async () => {
      const h = makeService({ createError: clash() });
      withEarningCount(h, 2);
      const at = new Date('2026-10-19T10:00:00Z');
      const winner = { id: PAYOUT_ID, operatorId: OPERATOR, paidByUserId: OWNER, idempotencyHash: 'huella-1', totalCents: 12_500, createdAt: at };
      // Al empezar no estaba; al volver a buscarla tras el choque, sí.
      h.tx.operatorPayout.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      await expect(h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem })).resolves.toEqual({
        id: PAYOUT_ID, totalCents: 12_500, earningCount: 2, createdAt: at.toISOString(),
      });
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it('la clave es de un pago de otra chica: 409 IDEMPOTENCY_KEY_REUSED, no «hash repetido»', async () => {
      const h = makeService({ createError: clash() });
      h.tx.operatorPayout.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: PAYOUT_ID, operatorId: 'otra-chica', paidByUserId: OWNER, idempotencyHash: 'huella-1', totalCents: 1, createdAt: NOW });
      const { body } = await errorOf(h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem }));
      expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it('no había pago con la clave: el choque era otro índice (hash on-chain) → 409 PAYOUT_TX_ALREADY_USED', async () => {
      const h = makeService({ createError: clash() });
      const { body } = await errorOf(h.svc.createPayout(TENANT, OPERATOR, OWNER, undefined, { idempotency: idem }));
      expect(body.code).toBe('PAYOUT_TX_ALREADY_USED');
      expect(h.tx.operatorPayout.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  it('findPayoutReplay: lo mismo fuera del pago (para no pedir otra vez el 2FA)', async () => {
    const h = makeService();
    await expect(h.svc.findPayoutReplay(TENANT, OPERATOR, OWNER, idem)).resolves.toBeNull();
    expect(h.prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});
