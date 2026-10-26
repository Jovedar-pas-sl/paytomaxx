import { describe, it, expect, vi } from 'vitest';
import { PosDeviceService } from './pos-device.service';
import { posReference, sha256 } from './paytef';
import type { PosDevice } from './device.guard';
import type { ApprovalProof } from '../gateways/gateway.adapter';
import type { PosSaleClaim } from './pos-sale-proof';

/**
 * La venta en el datáfono con la «Comisión del servicio»: el datáfono pide al
 * lector el total con la comisión (33 € + 3,30 €), el resultado tiene que
 * casar con ese total y lo devolvible es todo lo cobrado. Un cobro de antes
 * (sin comisión) sigue con su importe de siempre.
 */

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const device: PosDevice = { terminalId: 'term-1', tenantId: 't-1', label: 'Barra 1', zone: 'BARRA', tokenHash: sha256('x') };

function payment(o: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    tenantId: 't-1',
    status: 'CREATED',
    captureMethod: 'POS_EXTERNAL',
    amountCents: 3300,
    serviceFeeCents: 330,
    currency: 'EUR',
    qrExpiresAt: new Date(Date.now() + 10 * 60_000),
    posOperationNumber: null,
    posTerminalId: null,
    tipGoesTo: null,
    walletId: null,
    createdBy: { role: 'OPERATOR' },
    terminalId: 'term-1',
    createdAt: new Date(),
    terminal: { zone: 'BARRA', label: 'Barra 1' },
    ...o,
  };
}

function makeService(p = payment()) {
  const tx = {
    payment: { findFirst: vi.fn().mockResolvedValue(p), findMany: vi.fn().mockResolvedValue([p]) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(1) },
    posTerminalOp: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const prepareTx = { payment: { update: vi.fn().mockResolvedValue({}) }, paymentEvent: { create: vi.fn().mockResolvedValue({}) } };
  const prepared: unknown[] = [];
  const locked = { ...p, availableAmountCents: p.amountCents + p.serviceFeeCents, tipCents: 0 };
  const payments = {
    transition: vi.fn(async (_id: string, _ev: unknown, _t: string, o?: { prepare?: (t: unknown, l: unknown) => Promise<unknown> }) => {
      if (o?.prepare) prepared.push(await o.prepare(prepareTx, locked));
    }),
  };
  const claims: PosSaleClaim[] = [];
  const prover = {
    prove: vi.fn(async (claim: PosSaleClaim): Promise<ApprovalProof> => {
      claims.push(claim);
      return { kind: 'confirmed', amountCents: claim.amountCents, currency: 'EUR' };
    }),
  };
  const svc = new PosDeviceService(prisma as never, payments as never, { log: vi.fn() } as never, { get: vi.fn() } as never, prover);
  return { svc, tx, prepared, claims, prepareTx };
}

const sale = (requestedAmount: number, tipAmount?: number) => ({
  approved: true,
  authorisationCode: '047215',
  paytefOperationNumber: '99812',
  transactionReference: posReference(PAYMENT_ID),
  requestedAmount,
  ...(tipAmount !== undefined ? { tipAmount } : {}),
});

describe('datáfono con la comisión del servicio', () => {
  it('/start da al lector el total con la comisión (36,30 €) y el desglose', async () => {
    const { svc } = makeService();
    await expect(svc.start(device, PAYMENT_ID)).resolves.toMatchObject({
      amountCents: 3630,
      baseAmountCents: 3300,
      serviceFeeCents: 330,
    });
  });

  it('la lista de cobros por datáfono enseña lo que se cobra (con la comisión)', async () => {
    const { svc } = makeService();
    const [row] = await svc.pending(device);
    expect(row).toMatchObject({ amountCents: 3630, baseAmountCents: 3300, serviceFeeCents: 330 });
  });

  it('el lector cobró 36,30 € + 2 € de propina → pagado; Paytef se comprueba por 38,30 € y todo es devolvible', async () => {
    const { svc, prepared, claims } = makeService();
    const out = await svc.reportResult(device, PAYMENT_ID, sale(3630, 200));
    expect(out).toMatchObject({ status: 'PAID' });
    expect(claims[0]).toMatchObject({ amountCents: 3830 });
    expect(prepared[0]).toMatchObject({ tipCents: 200, availableAmountCents: 3830 });
  });

  it('el lector cobró solo 33 € (sin la comisión) → no cuadra: anular', async () => {
    const { svc } = makeService();
    const out = await svc.reportResult(device, PAYMENT_ID, sale(3300));
    expect(out).toMatchObject({ status: 'MISMATCH' });
    expect(out.message).toMatch(/el cobro era de 36,30/);
  });

  it('la propina máxima va sobre el consumo (no sobre la comisión)', async () => {
    const { svc } = makeService();
    const out = await svc.reportResult(device, PAYMENT_ID, sale(3630, 3301));
    expect(out).toMatchObject({ status: 'MISMATCH' });
  });

  it('un cobro de antes (sin comisión) sigue con su importe de siempre', async () => {
    const { svc } = makeService(payment({ serviceFeeCents: 0 }));
    await expect(svc.start(device, PAYMENT_ID)).resolves.toMatchObject({ amountCents: 3300 });
    await expect(svc.reportResult(device, PAYMENT_ID, sale(3300))).resolves.toMatchObject({ status: 'PAID' });
  });

  it('el cierre de jornada cuadra la operación por importe + comisión + propina', async () => {
    const { svc, tx } = makeService();
    tx.payment.findMany.mockResolvedValue([{ posOperationNumber: '99812', amountCents: 3300, serviceFeeCents: 330, tipCents: 200 }]);
    const out = await svc.reportShift(device, [{ paytefOperationNumber: '99812', opType: 'sale', amountWithSign: '38.30' } as never]);
    expect(out).toMatchObject({ total: 1, matched: 1, unmatched: [] });
  });
});
