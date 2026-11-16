import { describe, it, expect, vi } from 'vitest';
import {
  ApprovalAlreadyDecidedError,
  assertNoPendingPayout,
  claimApproval,
  expirePending,
  expiryCutoff,
  pendingRefundApprovalCents,
  replayPayoutRequest,
} from './approval-store';

const now = new Date('2026-10-16T03:00:00Z');
const dayBefore = new Date('2026-10-15T03:00:00Z');

function txWith(approvalRequest: Record<string, unknown>) {
  return { approvalRequest } as never;
}

describe('approval_requests dentro de la transacción', () => {
  it('una pendiente reserva solo 24 h', () => {
    expect(expiryCutoff(now)).toEqual(dayBefore);
  });

  it('lo pedido para devolver de un cobro: pendientes sin caducar y, en efectivo, aprobadas sin «Entregado» (24 h)', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amountCents: 15_000 } });
    expect(await pendingRefundApprovalCents(txWith({ aggregate }), 'pay-1', now)).toBe(15_000);
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        kind: 'REFUND',
        targetId: 'pay-1',
        OR: [
          { status: 'PENDING', requestedAt: { gt: dayBefore } },
          { status: 'APPROVED', resultRef: null, decidedAt: { gt: dayBefore } },
        ],
      },
      _sum: { amountCents: true },
    });
    aggregate.mockResolvedValueOnce({ _sum: { amountCents: null } });
    expect(await pendingRefundApprovalCents(txWith({ aggregate }), 'pay-1', now)).toBe(0);
  });

  it('pago directo con una petición pendiente para la chica → 409 APPROVAL_ALREADY_PENDING', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'ap-1', amountCents: 14_000 });
    await expect(assertNoPendingPayout(txWith({ findFirst }), 't-1', 'chica', now)).rejects.toMatchObject({
      response: { code: 'APPROVAL_ALREADY_PENDING', message: expect.stringContaining('140 €') },
    });
    findFirst.mockResolvedValueOnce(null);
    await expect(assertNoPendingPayout(txWith({ findFirst }), 't-1', 'chica', now)).resolves.toBeUndefined();
  });

  it('aprobar marca PENDING → APPROVED solo si sigue pendiente y sin caducar; si no, no hace nada más', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await claimApproval(txWith({ updateMany }), 'ap-1', 'jefe', now);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'ap-1', status: 'PENDING', requestedAt: { gt: dayBefore } },
      data: { status: 'APPROVED', decidedById: 'jefe', decidedAt: now },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(claimApproval(txWith({ updateMany }), 'ap-1', 'jefe', now)).rejects.toBeInstanceOf(ApprovalAlreadyDecidedError);
  });

  it('caducar: las pendientes de más de 24 h (de una chica o cobro, o todas) pasan a EXPIRED', async () => {
    const rows = [{ id: 'ap-1', tenantId: 't-1', kind: 'PAYOUT', amountCents: 100, requestedById: 'ana' }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    expect(await expirePending(txWith({ findMany, updateMany }), now, { targetId: 'chica' })).toEqual(rows);
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', requestedAt: { lte: dayBefore }, targetId: 'chica', id: { in: ['ap-1'] } },
      data: { status: 'EXPIRED', decidedAt: now },
    });
    findMany.mockResolvedValueOnce([]);
    updateMany.mockClear();
    expect(await expirePending(txWith({ findMany, updateMany }), now)).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  describe('petición de pago repetida con la misma Idempotency-Key', () => {
    const idempotency = { key: 'pedir-0001-abcdef', hash: 'h-1' };
    const input = { tenantId: 't-1', operatorId: 'chica', requestedById: 'ana', idempotency };
    const prior = { id: 'ap-1', kind: 'PAYOUT', targetId: 'chica', requestedById: 'ana', idempotencyHash: 'h-1', status: 'REJECTED' };

    it('sin pedir antes con esa clave: null (se pide)', async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      expect(await replayPayoutRequest(txWith({ findFirst }), input)).toBeNull();
      expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: 't-1', idempotencyKey: 'pedir-0001-abcdef' } });
    });

    it('la misma petición: la misma solicitud, esté como esté', async () => {
      const findFirst = vi.fn().mockResolvedValue(prior);
      expect(await replayPayoutRequest(txWith({ findFirst }), input)).toBe(prior);
    });

    it.each([
      ['otra petición (otra cifra, otras notas…)', { idempotencyHash: 'h-2' }],
      ['otra chica', { targetId: 'otra' }],
      ['otra persona', { requestedById: 'bea' }],
      ['una devolución', { kind: 'REFUND' }],
    ])('%s con la misma clave → 409 IDEMPOTENCY_KEY_REUSED', async (_caso, change) => {
      const findFirst = vi.fn().mockResolvedValue({ ...prior, ...change });
      await expect(replayPayoutRequest(txWith({ findFirst }), input)).rejects.toMatchObject({
        response: { code: 'IDEMPOTENCY_KEY_REUSED' },
      });
    });
  });
});
