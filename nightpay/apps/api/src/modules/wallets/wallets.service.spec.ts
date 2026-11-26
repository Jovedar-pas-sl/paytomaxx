import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { reversalAlertText } from './wallet-reversal-alert';
import { PAID_STATUSES_SQL, paymentAt } from '../reports/reporting-sql';

/**
 * Tests con mocks de Prisma — no toca DB. Cubrimos lo que la DB no garantiza
 * sola: el alta del saldo y el orden de bloqueos y decisiones al anular un
 * consumo (los choques de verdad, en las pruebas contra Postgres).
 */

const TENANT = 't-1';

/** El SQL de una llamada a $queryRaw / $executeRaw (con ? en lugar de los valores). */
const sqlOf = (call: unknown[]): string => (call[0] as TemplateStringsArray).join('?');

interface WalletRow {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  balanceCents: number;
  status: string;
  shortCode: string | null;
  mergedIntoId: string | null;
}

interface ReversalOptions {
  consumption?: Record<string, unknown> | null;
  wallets?: Record<string, Partial<WalletRow>>;
  earning?: Record<string, unknown> | null;
  debtCents?: number;
  /** Otro saldo activo tiene ya este código. */
  takenCode?: string;
  actorGroup?: string | null;
  /** Umbral de «Por aprobar» del local. */
  threshold?: number;
  /** Lo ya anulado en el saldo (importe + propina). */
  reversedCents?: number;
}

function makeService(o: ReversalOptions = {}) {
  const wallets: Record<string, WalletRow> = {};
  const base: WalletRow = {
    id: 'w-1',
    tenantId: 'home',
    walletGroup: 'principal',
    balanceCents: 1000,
    status: 'ACTIVE',
    shortCode: 'K7Q4M2',
    mergedIntoId: null,
  };
  for (const [id, row] of Object.entries({ 'w-1': {}, ...o.wallets })) wallets[id] = { ...base, id, ...row };
  const consumption =
    o.consumption === null
      ? null
      : { id: 'c-1', tenantId: 'other', amountCents: 4000, tipCents: 500, notes: null, reversedAt: null, ...o.consumption };
  const earning =
    o.earning === null
      ? null
      : { id: 'e-1', tenantId: 'other', commissionCents: 2000, tipCents: 500, reversedCents: 0, payoutId: null, ...o.earning };

  const txMock = {
    $queryRaw: vi.fn().mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const q = sql.join('?');
      if (q.includes('FROM wallet_consumptions') && q.includes('"reversedAt" IS NOT NULL')) {
        return [{ total: BigInt(o.reversedCents ?? 0) }];
      }
      if (q.includes('FROM wallet_consumptions')) return consumption ? [consumption] : [];
      if (q.includes('"shortCode" = ?')) return values[0] === o.takenCode ? [{ id: 'otro' }] : [];
      if (q.includes('FROM client_wallets')) {
        const w = wallets[values[0] as string];
        return w ? [{ ...w }] : [];
      }
      if (q.includes('FROM operator_earnings')) return earning ? [earning] : [];
      if (q.includes('FROM earning_reversals')) return [{ total: BigInt(o.debtCents ?? 0) }];
      return [];
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
    walletConsumption: { update: vi.fn().mockResolvedValue({}) },
    clientWallet: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'w-new',
        qrToken: 'tok-abc123',
        ...data,
      })),
    },
  };
  const run = async <T>(cb: (tx: typeof txMock) => Promise<T>) => cb(txMock);
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(run),
    acrossVenues: vi.fn().mockImplementation(run),
    $transaction: vi.fn().mockImplementation(run),
    venue: {
      findUnique: vi.fn().mockResolvedValue({
        walletGroup: o.actorGroup === undefined ? 'principal' : o.actorGroup,
        refundApprovalThresholdCents: o.threshold ?? 10_000,
      }),
    },
  };
  const auditMock = { log: vi.fn().mockResolvedValue(undefined) };
  const totpMock = { assertForUser: vi.fn().mockResolvedValue(undefined), isEnabled: vi.fn().mockResolvedValue(true) };
  const svc = new WalletsService(prismaMock as never, auditMock as never, totpMock as never);
  return { svc, prismaMock, txMock, auditMock, wallets, totpMock };
}

/** Anula c-1 de w-1 desde el local "other" (donde se cobró). */
const reverse = (svc: WalletsService) =>
  svc.reverseConsumption({ tenantId: 'other', walletId: 'w-1', consumptionId: 'c-1', actorUserId: 'u-man', totpCode: '123456', reason: 'error' });

describe('WalletsService.createEmpty', () => {
  it('creates wallet with balance 0 and base64url qrToken', async () => {
    const { svc, txMock } = makeService();
    const w = await svc.createEmpty({ tenantId: TENANT, identifier: 'phone-123' });
    expect(w.id).toBe('w-new');
    expect(w.qrToken).toBeDefined();
    expect(txMock.clientWallet.create).toHaveBeenCalledOnce();
    const callArgs = txMock.clientWallet.create.mock.calls[0]![0];
    expect(callArgs.data.tenantId).toBe(TENANT);
    expect(callArgs.data.identifier).toBe('phone-123');
    expect(callArgs.data.qrToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // Saldo NightPay: código corto para el cliente y grupo de locales.
    expect(callArgs.data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(callArgs.data.walletGroup).toBe('principal');
  });
});

describe('anular un consumo del saldo', () => {
  it('no existe (o es de otro local) → 404; ya anulado → 409', async () => {
    await expect(reverse(makeService({ consumption: null }).svc)).rejects.toThrow(NotFoundException);
    await expect(reverse(makeService({ consumption: { reversedAt: new Date() } }).svc)).rejects.toThrow(ConflictException);
  });

  it('el consumo se bloquea (doble clic) y es el del local que lo anula', async () => {
    const { svc, txMock } = makeService();
    await reverse(svc);
    const first = sqlOf(txMock.$queryRaw.mock.calls[0]!);
    expect(first).toMatch(/FROM wallet_consumptions[\s\S]*"tenantId" = \?::uuid[\s\S]*FOR UPDATE/);
    expect(txMock.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['c-1', 'w-1', 'other']);
  });

  it('consumo de otro local del grupo: se anula (el saldo se busca por su id, no por el local)', async () => {
    const { svc, txMock } = makeService();
    const out = await reverse(svc);
    expect(out).toEqual({ refundedCents: 4500, newBalanceCents: 5500 });
    const walletLocks = txMock.$queryRaw.mock.calls.map(sqlOf).filter((q) => /FROM client_wallets[\s\S]*FOR UPDATE/.test(q));
    expect(walletLocks.length).toBeGreaterThan(0);
    for (const q of walletLocks) expect(q).not.toMatch(/"tenantId" =/);
    expect(txMock.clientWallet.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { balanceCents: { increment: 4500 } },
    });
  });

  it('desde un local de otro grupo, no', async () => {
    await expect(reverse(makeService({ actorGroup: 'otro-dueño' }).svc)).rejects.toThrow(NotFoundException);
  });

  it('saldo ya devuelto o caducado: no se reabre (se le devuelve aparte)', async () => {
    for (const status of ['REFUNDED', 'EXPIRED']) {
      const { svc, txMock } = makeService({ wallets: { 'w-1': { status } } });
      await expect(reverse(svc)).rejects.toThrow(/devuélvele este importe aparte/);
      expect(txMock.clientWallet.update).not.toHaveBeenCalled();
    }
  });

  it('a 0 (DEPLETED) se reabre; si su código lo tiene ya otro cliente activo, con uno nuevo', async () => {
    const { svc, txMock } = makeService({ wallets: { 'w-1': { status: 'DEPLETED', balanceCents: 0 } }, takenCode: 'K7Q4M2' });
    await reverse(svc);
    const data = txMock.clientWallet.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ balanceCents: { increment: 4500 }, status: 'ACTIVE' });
    expect(data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(data.shortCode).not.toBe('K7Q4M2');
  });

  it('saldo sumado a otro (Face ID): el dinero vuelve al saldo que usa el cliente; el viejo sigue cerrado', async () => {
    const { svc, txMock, auditMock } = makeService({
      wallets: { 'w-1': { status: 'DEPLETED', balanceCents: 0, mergedIntoId: 'w-2' }, 'w-2': { balanceCents: 3000 } },
    });
    const out = await reverse(svc);
    expect(out).toEqual({ refundedCents: 4500, newBalanceCents: 7500 });
    expect(txMock.clientWallet.update).toHaveBeenCalledTimes(1);
    expect(txMock.clientWallet.update).toHaveBeenCalledWith({
      where: { id: 'w-2' },
      data: { balanceCents: { increment: 4500 } },
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.consumption.reversed',
        payload: expect.objectContaining({ creditedWalletId: 'w-2' }),
      }),
    );
  });

  it('la parte de la chica sin pagar se anula entera (con su fila bloqueada)', async () => {
    const { svc, txMock } = makeService();
    await reverse(svc);
    const earningLock = txMock.$queryRaw.mock.calls.map(sqlOf).find((q) => q.includes('FROM operator_earnings'));
    expect(earningLock).toMatch(/"consumptionId" = \?::uuid[\s\S]*FOR UPDATE/);
    const writes = txMock.$executeRaw.mock.calls.map(sqlOf);
    expect(writes.some((q) => q.includes('INSERT INTO earning_reversals'))).toBe(false);
    const update = txMock.$executeRaw.mock.calls.find((c) => sqlOf(c).includes('UPDATE operator_earnings'))!;
    expect(sqlOf(update)).toMatch(/"reversedCents" = "reversedCents" \+ \?/);
    expect(update.slice(1)).toEqual([2500, 'e-1']);
  });

  it('ya pagada a la chica (lo dice la fila bloqueada): deuda para su siguiente pago, el earning no se toca', async () => {
    const { svc, txMock } = makeService({ earning: { payoutId: 'po-1' } });
    await reverse(svc);
    const writes = txMock.$executeRaw.mock.calls.map(sqlOf);
    expect(writes.some((q) => q.includes('UPDATE operator_earnings'))).toBe(false);
    const debt = txMock.$executeRaw.mock.calls.find((c) => sqlOf(c).includes('INSERT INTO earning_reversals'))!;
    expect(sqlOf(debt)).toMatch(/"afterPayout"[\s\S]*true/);
    expect(debt.slice(1)).toEqual(['other', 'e-1', 'c-1', 2500]);
  });

  it('lo ya descontado (deudas de antes) no se descuenta dos veces', async () => {
    const { svc, txMock } = makeService({ earning: { payoutId: 'po-1' }, debtCents: 2500 });
    await reverse(svc);
    expect(txMock.$executeRaw.mock.calls.map(sqlOf).some((q) => q.includes('earning_reversals'))).toBe(false);
  });
});

describe('anular un cobro con saldo: siempre con 2FA, no hay otro camino', () => {
  const anular = (svc: WalletsService, totpCode?: string) =>
    svc.reverseConsumption({
      tenantId: 'other',
      walletId: 'w-1',
      consumptionId: 'c-1',
      actorUserId: 'u-1',
      totpCode,
      reason: 'error',
    });

  it('sin código, por poco que sea: 403 TOTP_REQUIRED y nada anulado', async () => {
    const { svc, txMock } = makeService({ threshold: 1_000_000 });
    const err = await anular(svc).catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    expect((err as Error).message).toMatch(/Para anular 45,00\u00a0€/);
    expect(txMock.clientWallet.update).not.toHaveBeenCalled();
    expect(txMock.walletConsumption.update).not.toHaveBeenCalled();
  });

  it('sin la app de verificación activada no se puede anular, y lo dice', async () => {
    const { svc, totpMock, txMock } = makeService();
    totpMock.isEnabled.mockResolvedValue(false);
    const err = await anular(svc).catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
    expect(txMock.clientWallet.update).not.toHaveBeenCalled();
  });

  it('con su código se anula (y queda en el registro que se pidió)', async () => {
    const { svc, totpMock, auditMock } = makeService();
    await expect(anular(svc, '123456')).resolves.toEqual({ refundedCents: 4500, newBalanceCents: 5500 });
    expect(totpMock.assertForUser).toHaveBeenCalledWith('u-1', '123456', expect.stringMatching(/^reverse:/));
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.consumption.reversed', payload: expect.objectContaining({ twoFactor: true }) }),
    );
  });

  it('un código malo no anula nada', async () => {
    const { svc, totpMock, txMock } = makeService();
    totpMock.assertForUser.mockRejectedValue(new ForbiddenException('Código incorrecto'));
    await expect(anular(svc, '000000')).rejects.toBeInstanceOf(ForbiddenException);
    expect(txMock.clientWallet.update).not.toHaveBeenCalled();
  });

  it('el aviso de Telegram dice cuánto vuelve, por qué y quién, sin el código del saldo', () => {
    const text = reversalAlertText({ venueName: 'Sala Aurora', refundedCents: 4500, reason: 'Se equivocó de copa', actor: 'Lucía' });
    expect(text).toContain('Sala Aurora');
    expect(text).toContain('45,00 €');
    expect(text).toContain('Se equivocó de copa');
    expect(text).toContain('Lucía');
  });

  describe('el aviso, de verdad', () => {
    const conAlertas = () => {
      const made = makeService();
      const telegram = { send: vi.fn().mockResolvedValue(true) };
      (made.txMock as Record<string, unknown>).user = { findUnique: vi.fn().mockResolvedValue({ displayName: 'Lucía', email: 'l@x.es' }) };
      made.prismaMock.venue.findUnique.mockResolvedValue({ walletGroup: 'principal', name: 'Sala Aurora', alertSettings: { chatId: '-100123' } } as never);
      const svc = new WalletsService(made.prismaMock as never, made.auditMock as never, made.totpMock as never, telegram as never);
      return { svc, telegram };
    };

    afterEach(() => vi.unstubAllEnvs());

    it('sale al chat del local, una vez anulado', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NIGHTPAY_DISABLE_ALERTS', '');
      const { svc, telegram } = conAlertas();
      await anular(svc, '123456');
      await vi.waitFor(() => expect(telegram.send).toHaveBeenCalledTimes(1));
      expect(telegram.send.mock.calls[0]![0]).toContain('Lucía');
      expect(telegram.send.mock.calls[0]![1]).toBe('-100123');
    });

    it('si Telegram falla, la anulación sigue hecha', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NIGHTPAY_DISABLE_ALERTS', '');
      const { svc, telegram } = conAlertas();
      telegram.send.mockRejectedValue(new Error('caído'));
      await expect(anular(svc, '123456')).resolves.toMatchObject({ refundedCents: 4500 });
      await vi.waitFor(() => expect(telegram.send).toHaveBeenCalled());
    });

    it('sin código no se avisa de nada', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NIGHTPAY_DISABLE_ALERTS', '');
      const { svc, telegram } = conAlertas();
      await expect(anular(svc)).rejects.toBeInstanceOf(ForbiddenException);
      expect(telegram.send).not.toHaveBeenCalled();
    });
  });
});

describe('estadísticas del panel de saldos', () => {
  function statsService() {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
        const q = sql.join('?');
        calls.push({ sql: q, values });
        if (q.includes('FROM client_wallets')) return [{ count: 3n, totalBalance: 12_000n }];
        if (q.includes('FROM payments')) return [{ total: 20_000n }];
        if (q.includes('FROM wallet_consumptions')) return [{ category: 'CHICA_SERVICE', total: 6_000n }, { category: 'VENUE_BAR', total: 1_500n }];
        if (q.includes('FROM wallet_payouts')) return [{ total: 4_500n }];
        if (q.includes('FROM wallet_cash_topups')) return [{ total: 5_000n }];
        return [];
      }),
    };
    const prisma = {
      withTenant: vi.fn().mockImplementation(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
      $queryRaw: tx.$queryRaw,
    };
    const svc = new WalletsService(prisma as never, { log: vi.fn() } as never);
    return { svc, calls, prisma };
  }

  it('lo devuelto hoy son las devoluciones del saldo hechas en este local (tarjeta y efectivo), no 0', async () => {
    const { svc, calls } = statsService();
    const stats = await svc.getAdminStats('t-1', { from: new Date('2026-10-15T22:00:00Z'), open: true });
    expect(stats).toEqual({
      activeCount: 3,
      totalBalanceCents: 12_000,
      nightOpen: true,
      // Recargas de hoy: con tarjeta (200 €) y en efectivo en la recepción (50 €).
      todayTopUpsCents: 25_000,
      todayConsumptionsCents: 7_500,
      todayRefundsCents: 4_500,
      byCategory: { CHICA_SERVICE: 6_000, VENUE_BAR: 1_500 },
    });
    const payouts = calls.find((c) => c.sql.includes('FROM wallet_payouts'))!;
    // Solo las hechas (una a la tarjeta a medias aún no), del local.
    expect(payouts.sql).toMatch(/status = 'DONE'/);
    expect(payouts.values[0]).toBe('t-1');
    // Las cinco consultas, filtradas por el local (no solo por el RLS de la sesión).
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.sql).toMatch(/"tenantId" = \?/);
      expect(c.values).toContain('t-1');
    }
  });

  it('las recargas de hoy cuadran con el Z: pagadas (también las devueltas luego), por cuándo las autorizó el banco', async () => {
    const { svc, calls } = statsService();
    await svc.getAdminStats('t-1', { from: new Date('2026-10-15T22:00:00Z'), open: true });
    const topUps = calls.find((c) => c.sql.includes('FROM payments'))!;
    expect(topUps.sql).not.toMatch(/'AUTHORIZED'/);
    expect(topUps.values).toContain(PAID_STATUSES_SQL);
    const sqlParts = topUps.values.map((v) => (v as { sql?: string } | null)?.sql);
    expect(sqlParts).toContain(paymentAt('p').sql);
  });

  it('cuenta desde el inicio de la noche que le pasan (no desde las 00:00 del servidor)', async () => {
    const { svc, calls, prisma } = statsService();
    await svc.getAdminStats('t-1', { from: new Date('2026-10-15T20:30:00Z'), open: true });
    const since = calls.map((c) => c.values.at(-1)).filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    expect(since).toHaveLength(4);
    expect(new Set(since)).toEqual(new Set(['2026-10-15T20:30:00.000Z']));
    // Con el local en la sesión (las tablas del saldo tienen RLS forzado) y, además, filtrado a mano.
    expect(prisma.withTenant).toHaveBeenCalledWith('t-1', expect.any(Function));
  });
});

describe('lista de saldos del panel: lo pedido antes de la nueva regla', () => {
  function listService(rows: Array<Record<string, unknown>>) {
    const tx = { clientWallet: { findMany: vi.fn(async () => rows) } };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { svc: new WalletsService(prisma as never, { log: vi.fn() } as never), tx };
  }
  const row = (o: Record<string, unknown> = {}) => ({
    id: 'w-1', identifier: null, balanceCents: 3_000, status: 'ACTIVE', expiresAt: null, createdAt: new Date('2026-11-16T22:00:00Z'),
    shortCode: 'K7Q4M2', closeRequestedAt: null, pinHash: null, pinLockedAt: null,
    _count: { consumptions: 0, passkeys: 0, cards: 0, payouts: 0 }, ...o,
  });

  it('dice si tiene una devolución a la tarjeta a medias (la termina el dueño aunque no hubiera «Me voy»)', async () => {
    const { svc, tx } = listService([row(), row({ id: 'w-2', balanceCents: 0, _count: { consumptions: 0, passkeys: 0, cards: 0, payouts: 1 } })]);
    const list = await svc.listForAdmin({ tenantId: 't-1' });
    expect(list.map((w) => [w.id, w.payoutPending])).toEqual([['w-1', false], ['w-2', true]]);
    // Solo cuentan las PENDING (las hechas no).
    const select = (tx.clientWallet.findMany.mock.calls[0] as unknown as [{ select: { _count: { select: { payouts: unknown } } } }])[0].select;
    expect(select._count.select.payouts).toEqual({ where: { status: 'PENDING' } });
  });
});
