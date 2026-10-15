import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';

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
      findUnique: vi.fn().mockResolvedValue({ walletGroup: o.actorGroup === undefined ? 'principal' : o.actorGroup }),
    },
  };
  const auditMock = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new WalletsService(prismaMock as never, auditMock as never);
  return { svc, prismaMock, txMock, auditMock, wallets };
}

/** Anula c-1 de w-1 desde el local "other" (donde se cobró). */
const reverse = (svc: WalletsService) =>
  svc.reverseConsumption({ tenantId: 'other', walletId: 'w-1', consumptionId: 'c-1', actorUserId: 'u-man', reason: 'error' });

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
