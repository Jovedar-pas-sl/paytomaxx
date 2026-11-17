import { describe, it, expect, vi } from 'vitest';
import { listUnpaidCobros } from './unpaid-cobros';

/** Una fila de payments como la devuelve el select de la lista. */
const row = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  ref: 31,
  status: 'AUTHORIZING',
  provider: 'REDSYS',
  posOperationNumber: null,
  amountCents: 2400,
  serviceFeeCents: 0,
  tipCents: 0,
  createdAt: new Date('2026-11-16T23:38:00.000Z'),
  createdByUserId: 'op-1',
  createdBy: { displayName: 'Lucía' },
  ...o,
});

function list(rows: Array<ReturnType<typeof row>>) {
  const findMany = vi.fn(async () => rows);
  const queryRaw = vi.fn(async () => []);
  const prisma = { payment: { findMany }, $queryRaw: queryRaw };
  return { findMany, queryRaw, items: listUnpaidCobros(prisma as never, { tenantId: 't-1', userId: 'waiter-1' }) };
}

describe('«Sin pagar en el local»: la recarga cobrada en el datáfono sin comprobar', () => {
  it('sale, pero ni «en su banco» (sin el reloj de los 2 minutos) ni cancelable: heldOnReader', async () => {
    const { items, findMany, queryRaw } = list([
      row({ id: 'hold', provider: 'PAYTEF', posOperationNumber: '99812', createdByUserId: null, createdBy: null, amountCents: 5000 }),
    ]);
    expect(await items).toEqual([
      expect.objectContaining({
        id: 'hold',
        status: 'AUTHORIZING',
        totalCents: 5000,
        atBank: false,
        bitcoin: false,
        heldOnReader: true,
        atBankSince: null,
        cancelableInMs: 0,
      }),
    ]);
    // Lee la operación del datáfono (la marca de Resolver); no pregunta desde cuándo está en su banco.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ posOperationNumber: true }) }));
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('el cliente en su banco, con bitcoin o sin empezar a pagar: como siempre, sin heldOnReader', async () => {
    const { items } = list([
      row({ id: 'banco' }),
      row({ id: 'btc', provider: 'BTCPAY' }),
      row({ id: 'qr', status: 'CREATED', provider: null }),
    ]);
    expect((await items).map((u) => [u.id, u.atBank, u.bitcoin, u.heldOnReader])).toEqual([
      ['banco', true, false, false],
      ['btc', false, true, false],
      ['qr', false, false, false],
    ]);
  });
});
