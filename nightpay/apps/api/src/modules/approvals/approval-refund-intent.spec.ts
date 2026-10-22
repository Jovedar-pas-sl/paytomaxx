import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ApprovalRequestsService } from './approval-requests.service';

const actor = { userId: 'manager', role: 'MANAGER' as const, tenantId: 'venue' };
const request = { paymentId: 'payment', amountCents: 1000, reason: 'Cliente se va', idempotencyKey: 'refund-approval-intent' };

function make() {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => sql.join('').includes('FOR UPDATE') ? [{ status: 'AUTHORIZED', availableAmountCents: 5000 }] : []),
    payment: { findFirst: vi.fn(async () => ({ id: 'payment', amountCents: 5000, tipCents: 0, provider: 'WIPAY', providerTxId: 'paid', walletId: null, createdAt: new Date(), cardBrand: null, cardLast4: null })) },
    refund: { aggregate: vi.fn(async () => ({ _sum: { amountCents: 0 } })), findUnique: vi.fn(async () => null) },
    approvalRequest: {
      findFirst: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) => rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null),
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { amountCents: 0 } })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `approval-${rows.length + 1}`, status: 'PENDING', ...data }; rows.push(row); return row; }),
    },
  };
  const prisma = { withTenant: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async () => undefined) };
  const svc = new ApprovalRequestsService(prisma as never, audit as never, {} as never, { enabled: () => false } as never);
  return { svc, tx, audit };
}

describe('refund approval intention', () => {
  it('repite la solicitud original aunque el cobro haya dejado de ser devolvible', async () => {
    const { svc, tx, audit } = make();
    const first = await svc.requestRefund(actor, request);
    tx.payment.findFirst.mockResolvedValueOnce(null as never);
    await expect(svc.requestRefund(actor, request)).resolves.toEqual(first);
    expect(tx.approvalRequest.create).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it.each(['actor', 'amount', 'payment'])('409 si cambia %s bajo la clave de aprobación', async (what) => {
    const { svc } = make();
    await svc.requestRefund(actor, request);
    await expect(svc.requestRefund(what === 'actor' ? { ...actor, userId: 'other' } : actor, { ...request, ...(what === 'amount' ? { amountCents: 2000 } : what === 'payment' ? { paymentId: 'other' } : {}) })).rejects.toBeInstanceOf(ConflictException);
  });
});
