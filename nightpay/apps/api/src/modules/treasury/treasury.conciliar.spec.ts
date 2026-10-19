import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

// Sala Bambú (Madrid): pagos en USDT a sus chicas y su conciliación on-chain.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OTHER_TENANT = '7d6c5b4a-3e2f-4a1b-9c0d-8e7f6a5b4c3d';
const PAYOUT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OWNER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const TRON_TO = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const HASH = '7c3f9a1e5b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e';
const CREATED = new Date('2026-10-18T10:00:00Z');
const NOW = new Date('2026-10-18T12:40:00+02:00');

const matched = (occurredAt = new Date('2026-10-18T10:20:00Z')) => ({
  matched: true,
  status: 'MATCHED',
  occurredAt,
  actualAmountCents: null,
  actualAmountUsdt: 135.31,
  reason: null,
});

interface Opts {
  payout?: Record<string, unknown> | null;
  otherWithTx?: { id: string; createdAt: Date } | null;
  verify?: (input: { externalTxId: string }) => Promise<unknown>;
  updateError?: Error;
  pending?: Array<Record<string, unknown>>;
}

function makeService(opts: Opts = {}) {
  const payout =
    opts.payout === null
      ? null
      : {
          id: PAYOUT_ID,
          tenantId: TENANT,
          totalCents: 12_500,
          createdAt: CREATED,
          reconciliationStatus: 'UNRECONCILED',
          externalTxId: null,
          externalRail: 'USDT_TRC20',
          expectedAmountUsdt: { toString: () => '135.3125' },
          payoutFxRate: { toString: () => '1.0825' },
          reconciledAt: null,
          operator: { id: 'op-1', email: 'lucia@salabambu.es', tenantId: TENANT, payoutMethod: 'USDT_TRC20', payoutAddress: TRON_TO },
          ...(opts.payout ?? {}),
        };
  const tx = {
    operatorPayout: {
      findUnique: vi.fn().mockResolvedValue(payout),
      findFirst: vi.fn().mockResolvedValue(opts.otherWithTx ?? null),
      findMany: vi.fn().mockResolvedValue(opts.pending ?? []),
      update: opts.updateError ? vi.fn().mockRejectedValue(opts.updateError) : vi.fn().mockResolvedValue(payout),
    },
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    withTenant: vi.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const verifier = { verify: vi.fn(opts.verify ?? (async () => matched())) };
  const factory = { forMethod: vi.fn().mockReturnValue(verifier) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new TreasuryService(prisma as never, audit as never, factory as never, { get: vi.fn() } as never);
  return { svc, tx, prisma, verifier, factory, audit };
}

const dto = { externalTxId: ` ${HASH} `, externalRail: 'USDT_TRC20' as const };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TreasuryService.verifyPayout — idempotencia', () => {
  it('mismo hash ya conciliado (MATCHED): devuelve lo anterior sin explorador, sin guardar ni registrar', async () => {
    const reconciledAt = new Date('2026-10-18T10:30:00Z');
    const { svc, verifier, tx, audit } = makeService({
      payout: { reconciliationStatus: 'MATCHED', externalTxId: HASH, reconciledAt },
    });
    expect(await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).toEqual({
      matched: true,
      status: 'MATCHED',
      occurredAt: reconciledAt.toISOString(),
      actualAmountCents: null,
      reason: 'already_reconciled',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('confirmado a mano (MANUAL_OK) con el mismo hash: igual, aunque no tenga fecha', async () => {
    const { svc, verifier } = makeService({ payout: { reconciliationStatus: 'MANUAL_OK', externalTxId: HASH } });
    expect(await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).toMatchObject({
      status: 'MANUAL_OK',
      occurredAt: null,
      reason: 'already_reconciled',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('conciliado pero con otro hash: se verifica de nuevo', async () => {
    const { svc, verifier } = makeService({ payout: { reconciliationStatus: 'MATCHED', externalTxId: 'hash-anterior' } });
    await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });
});

describe('TreasuryService.verifyPayout — pago, local y dirección', () => {
  it('pago que no existe → 404', async () => {
    const { svc } = makeService({ payout: null });
    await expect(svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pago de otro local → 403 sin cruzar hashes ni llamar al explorador', async () => {
    const { svc, tx, verifier } = makeService({ payout: { tenantId: OTHER_TENANT } });
    await expect(svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.operatorPayout.findFirst).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rail cripto y la chica sin dirección de cobro → 400 sin guardar', async () => {
    const { svc, tx } = makeService({
      payout: { operator: { id: 'op-1', email: 'lucia@salabambu.es', tenantId: TENANT, payoutMethod: null, payoutAddress: null } },
    });
    await expect(svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
  });

  it('hash en otro pago del local → 409 con el código y el pago que lo tiene', async () => {
    const other = { id: '3c4d5e6f-0000-4000-8000-000000000009', createdAt: new Date('2026-10-11T18:00:00Z') };
    const { svc } = makeService({ otherWithTx: other });
    const err = await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'PAYOUT_TX_ALREADY_USED', payoutId: other.id });
  });

  it('otro fallo al guardar se propaga tal cual', async () => {
    const boom = new Error('deadlock detected');
    const { svc } = makeService({ updateError: boom });
    await expect(svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).rejects.toBe(boom);
  });
});

describe('TreasuryService.verifyPayout — resultado guardado', () => {
  it('override manual: MANUAL_OK sin explorador ni cruce de hash; guarda quién y cuándo', async () => {
    const { svc, verifier, tx, audit } = makeService();
    const res = await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, { ...dto, manualOverride: true });
    expect(res).toMatchObject({ matched: true, status: 'MANUAL_OK', occurredAt: NOW.toISOString(), reason: 'manual_override' });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(tx.operatorPayout.findFirst).not.toHaveBeenCalled();
    expect(tx.operatorPayout.update).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID },
      data: {
        externalTxId: HASH,
        externalRail: 'USDT_TRC20',
        reconciliationStatus: 'MANUAL_OK',
        reconciledAt: NOW,
        reconciledByUserId: OWNER,
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.payout.verified', payload: expect.objectContaining({ manualOverride: true }) }),
    );
  });

  it('el explorador aún no ve la transacción: sigue UNRECONCILED, sin marcar conciliado', async () => {
    const { svc, tx } = makeService({
      verify: async () => ({ matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason: 'not_found' }),
    });
    const res = await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, { ...dto, receiptUrl: 'https://tronscan.org/#/transaction/x' });
    expect(res).toMatchObject({ matched: false, status: 'UNRECONCILED', reason: 'not_found', actualAmountCents: null });
    expect(tx.operatorPayout.update.mock.calls[0]![0].data).toEqual({
      externalTxId: HASH,
      externalRail: 'USDT_TRC20',
      reconciliationStatus: 'UNRECONCILED',
      receiptUrl: 'https://tronscan.org/#/transaction/x',
    });
  });

  it('sin foto del tipo en el pago, lo recibido en EUR queda null', async () => {
    const { svc } = makeService({ payout: { payoutFxRate: null } });
    expect(await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).toMatchObject({ actualAmountUsdt: 135.31, actualAmountCents: null });
  });

  it('con la foto del tipo: lo recibido en USDT pasado a EUR', async () => {
    const { svc } = makeService();
    expect(await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).toMatchObject({ actualAmountCents: 12_500 });
  });

  it('si el explorador ya da el importe en EUR, se usa tal cual', async () => {
    const { svc } = makeService({ verify: async () => ({ ...matched(), actualAmountCents: 12_480 }) });
    expect(await svc.verifyPayout(TENANT, PAYOUT_ID, OWNER, dto)).toMatchObject({ actualAmountCents: 12_480 });
  });
});

describe('TreasuryService.reconcilePending — repaso automático', () => {
  const pendingPayout = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenantId: TENANT,
    totalCents: 12_500,
    createdAt: CREATED,
    externalRail: 'USDT_TRC20',
    externalTxId: `hash-${id}`,
    expectedAmountUsdt: null,
    operator: { payoutAddress: TRON_TO },
    ...extra,
  });

  it('repasa solo pagos del local, pendientes, con hash y rail cripto (100 como mucho, los más viejos antes)', async () => {
    const { svc, tx, prisma } = makeService();
    expect(await svc.reconcilePending(TENANT)).toEqual({ checked: 0, matched: 0 });
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(tx.operatorPayout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          reconciliationStatus: 'UNRECONCILED',
          externalTxId: { not: null },
          externalRail: { in: ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'] },
        },
        take: 100,
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('cuadra → MATCHED con la fecha de la transacción', async () => {
    const occurredAt = new Date('2026-10-18T10:20:00Z');
    const { svc, tx } = makeService({ pending: [pendingPayout('po-1')], verify: async () => matched(occurredAt) });
    expect(await svc.reconcilePending(TENANT)).toEqual({ checked: 1, matched: 1 });
    expect(tx.operatorPayout.update).toHaveBeenCalledWith({
      where: { id: 'po-1' },
      data: { reconciliationStatus: 'MATCHED', reconciledAt: occurredAt },
    });
  });

  it('un explorador caído en un pago no frena el resto (7 pagos en lotes de 5)', async () => {
    const pending = Array.from({ length: 7 }, (_, i) => pendingPayout(`po-${i + 1}`));
    const { svc, verifier, tx } = makeService({
      pending,
      verify: async ({ externalTxId }) => {
        if (externalTxId === 'hash-po-3') throw new Error('tronscan 503');
        return matched();
      },
    });
    expect(await svc.reconcilePending(TENANT)).toEqual({ checked: 7, matched: 6 });
    expect(verifier.verify).toHaveBeenCalledTimes(7);
    expect(tx.operatorPayout.update).toHaveBeenCalledTimes(6);
  });

  it('sin dirección de la chica o con el hash en blanco: se salta sin llamar al explorador', async () => {
    const { svc, verifier } = makeService({
      pending: [pendingPayout('po-1', { operator: { payoutAddress: null } }), pendingPayout('po-2', { externalTxId: '   ' })],
    });
    expect(await svc.reconcilePending(TENANT)).toEqual({ checked: 2, matched: 0 });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('al explorador va el hash recortado y la foto en USDT del pago', async () => {
    const { svc, verifier, factory } = makeService({
      pending: [pendingPayout('po-1', { externalTxId: ` ${HASH} `, expectedAmountUsdt: { toString: () => '135.3125' } })],
    });
    await svc.reconcilePending(TENANT);
    expect(factory.forMethod).toHaveBeenCalledWith('USDT_TRC20');
    expect(verifier.verify).toHaveBeenCalledWith({
      externalTxId: HASH,
      expectedToAddress: TRON_TO,
      expectedAmountCents: 12_500,
      expectedAmountUsdt: 135.3125,
    });
  });

  it('importe distinto → sigue pendiente', async () => {
    const { svc, tx } = makeService({
      pending: [pendingPayout('po-1')],
      verify: async () => ({ matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason: 'importe_distinto' }),
    });
    expect(await svc.reconcilePending(TENANT)).toEqual({ checked: 1, matched: 0 });
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
  });
});
