import { describe, expect, it, vi } from 'vitest';
import { stampRefundServiceFee } from './refund-ledger';

/**
 * La parte de una devolución que es «Comisión del servicio»: en proporción a
 * lo cobrado, por lo acumulado (dos mitades suman la comisión entera). Se
 * apunta en la devolución, con el cobro bloqueado. Una recarga no la devuelve.
 */

function tx(prior: { amountCents: number | null; serviceFeeCents: number | null }) {
  return {
    refund: {
      aggregate: vi.fn(async () => ({ _sum: prior })),
      update: vi.fn(async () => ({})),
    },
  };
}

// 33 € + 3,30 € de comisión + 2 € de propina = 38,30 €.
const payment = { id: 'p1', amountCents: 3300, serviceFeeCents: 330, tipCents: 200, walletId: null };

describe('stampRefundServiceFee', () => {
  it('devolución total: toda la comisión vuelve al cliente', async () => {
    const t = tx({ amountCents: null, serviceFeeCents: null });
    await expect(stampRefundServiceFee(t as never, payment, 'r1', 3830)).resolves.toBe(330);
    expect(t.refund.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { serviceFeeCents: 330 } });
    expect(t.refund.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: 'p1', status: 'SUCCEEDED', id: { not: 'r1' } } }),
    );
  });

  it('en dos partes: la segunda lleva lo que falta (sin céntimos sueltos)', async () => {
    const first = await stampRefundServiceFee(tx({ amountCents: null, serviceFeeCents: null }) as never, payment, 'r1', 1100);
    expect(first).toBe(95);
    const second = await stampRefundServiceFee(tx({ amountCents: 1100, serviceFeeCents: first }) as never, payment, 'r2', 2730);
    expect(first + second).toBe(330);
  });

  it('sin comisión o en una recarga: nada (ni consulta)', async () => {
    const t = tx({ amountCents: null, serviceFeeCents: null });
    await expect(stampRefundServiceFee(t as never, { ...payment, serviceFeeCents: 0 }, 'r1', 1000)).resolves.toBe(0);
    await expect(stampRefundServiceFee(t as never, { ...payment, walletId: 'w1' }, 'r1', 1000)).resolves.toBe(0);
    await expect(stampRefundServiceFee(t as never, { id: 'p1', amountCents: 3300, tipCents: 0, walletId: null }, 'r1', 1000)).resolves.toBe(0);
    expect(t.refund.aggregate).not.toHaveBeenCalled();
    expect(t.refund.update).not.toHaveBeenCalled();
  });
});
