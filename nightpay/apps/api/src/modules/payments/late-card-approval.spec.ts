import { describe, it, expect, vi } from 'vitest';
import {
  APPROVAL_UNBOOKED_EVENT,
  CARD_REFUNDED_AFTER_SALDO_EVENT,
  lateApprovalHandled,
  settleLateCardApproval,
  wasPaidWithSaldo,
} from './late-card-approval';

const PAYMENT = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const SALA = '3c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f';
const target = { id: PAYMENT, tenantId: SALA, amountCents: 2000 };

function fakePrisma(o: { attemptCents?: number | null; events?: Array<{ payload: unknown }>; paidWithSaldo?: number } = {}) {
  const tx = {
    paymentAttempt: {
      findFirst: vi.fn(async () => (o.attemptCents === undefined ? null : { amountCents: o.attemptCents })),
    },
    paymentEvent: {
      count: vi.fn(async () => o.paidWithSaldo ?? 0),
      findMany: vi.fn(async () => o.events ?? []),
    },
  };
  return { tx, prisma: { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
}

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('tarjeta aprobada después de pagar con el saldo', () => {
  it('la pasarela devuelve por API: se devuelve lo cobrado en ese pedido (con propina), sin incidencia', async () => {
    const { prisma } = fakePrisma({ attemptCents: 2500 });
    const refund = vi.fn(async () => ({ providerRefundId: 'RF-1', status: 'SUCCEEDED' as const }));
    const out = await settleLateCardApproval(
      { prisma: prisma as never, adapter: { provider: 'PAYTEF', refund } as never, logger },
      target,
      'PT123',
    );
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT, tenantId: SALA, providerTxId: 'PT123', amountCents: 2500, reference: 'saldo-PT123' }),
    );
    expect(out).toEqual({
      eventType: CARD_REFUNDED_AFTER_SALDO_EVENT,
      payload: { provider: 'PAYTEF', providerTxId: 'PT123', amountCents: 2500, providerRefundId: 'RF-1' },
    });
  });

  it('Redsys no devuelve por API: incidencia «cobrado dos veces» con el pedido y el importe del cobro', async () => {
    const { prisma } = fakePrisma();
    const refund = vi.fn(async () => {
      throw new Error('Redsys refund vía API no implementado');
    });
    const out = await settleLateCardApproval(
      { prisma: prisma as never, adapter: { provider: 'REDSYS', refund } as never, logger },
      target,
      'RS9',
    );
    expect(out.eventType).toBe(APPROVAL_UNBOOKED_EVENT);
    expect(out.payload).toMatchObject({
      provider: 'REDSYS',
      providerTxId: 'RS9',
      amountCents: 2000,
      fromStatus: 'CANCELED',
      reason: 'paid_with_saldo',
      refundError: expect.stringMatching(/no implementado/),
    });
  });

  it('una devolución sin confirmar o rechazada tampoco se da por buena: incidencia', async () => {
    for (const status of ['PENDING', 'FAILED'] as const) {
      const { prisma } = fakePrisma({ attemptCents: null });
      const out = await settleLateCardApproval(
        { prisma: prisma as never, adapter: { provider: 'PAYTEF', refund: async () => ({ providerRefundId: 'x', status }) } as never, logger },
        target,
        'PT7',
      );
      expect(out.eventType).toBe(APPROVAL_UNBOOKED_EVENT);
      expect(out.payload).toMatchObject({ amountCents: 2000, refundError: status === 'PENDING' ? 'refund-pending' : 'refund-failed' });
    }
  });

  it('sabe si el cobro lo pagó el saldo y si un pedido ya se trató', async () => {
    expect(await wasPaidWithSaldo(fakePrisma({ paidWithSaldo: 1 }).prisma as never, PAYMENT)).toBe(true);
    expect(await wasPaidWithSaldo(fakePrisma().prisma as never, PAYMENT)).toBe(false);
    const handled = fakePrisma({ events: [{ payload: { providerTxId: 'A1' } }, { payload: null }] }).prisma;
    expect(await lateApprovalHandled(handled as never, PAYMENT, 'A1')).toBe(true);
    expect(await lateApprovalHandled(handled as never, PAYMENT, 'B2')).toBe(false);
  });
});
