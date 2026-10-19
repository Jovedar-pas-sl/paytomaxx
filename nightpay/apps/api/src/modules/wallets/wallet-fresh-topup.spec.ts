import { describe, it, expect, vi } from 'vitest';
import { FRESH_TOPUP_MS, firstTopUp, isFreshTopUpBy, type FirstTopUp } from './wallet-fresh-topup';

/**
 * «Recién recargado»: quien cobró la primera recarga del saldo (persona o
 * datáfono de recepción), en sus 15 minutos, pone el primer PIN y da la ficha.
 * Cuenta la recarga con tarjeta y la de efectivo: la primera de las dos.
 */

const NOW = new Date('2026-10-21T01:00:00Z');
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const RECEPCION = 'term-recepcion';

function db(payment: Record<string, unknown> | null, cash: Record<string, unknown> | null) {
  const tx = {
    payment: { findFirst: vi.fn().mockResolvedValue(payment) },
    walletCashTopUp: { findFirst: vi.fn().mockResolvedValue(cash) },
  };
  return { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), tx };
}

describe('la primera recarga del saldo', () => {
  it('con tarjeta (la cobró la chica) o en efectivo (la recepción): la que llegó antes', async () => {
    const card = { createdByUserId: LOLA, authorizedAt: NOW, posTerminalId: null, createdAt: new Date(NOW.getTime() - 60_000) };
    const cash = { takenByUserId: null, terminalId: RECEPCION, createdAt: NOW };
    const both = db(card, cash);
    await expect(firstTopUp(both as never, 'w-1')).resolves.toEqual({
      userId: LOLA, terminalId: null, at: NOW, createdAt: card.createdAt,
    });
    expect(both.tx.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'w-1' }, orderBy: { createdAt: 'asc' } }),
    );
    expect(both.tx.walletCashTopUp.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'w-1' }, orderBy: { createdAt: 'asc' } }),
    );

    const earlierCash = db({ ...card, createdAt: NOW }, { ...cash, createdAt: new Date(NOW.getTime() - 60_000) });
    await expect(firstTopUp(earlierCash as never, 'w-1')).resolves.toMatchObject({ terminalId: RECEPCION, userId: null });
  });

  it('solo una de las dos, o ninguna', async () => {
    await expect(firstTopUp(db(null, { takenByUserId: LOLA, terminalId: null, createdAt: NOW }) as never, 'w')).resolves.toEqual({
      userId: LOLA, terminalId: null, at: NOW, createdAt: NOW,
    });
    await expect(firstTopUp(db(null, null) as never, 'w')).resolves.toBeNull();
  });
});

describe('¿es de quien pregunta y de hace menos de 15 min?', () => {
  const cashBy = (o: Partial<FirstTopUp>): FirstTopUp => ({ userId: null, terminalId: null, at: NOW, createdAt: NOW, ...o });

  it('la persona que la cobró, o el datáfono que la cobró; nadie más', () => {
    expect(isFreshTopUpBy(cashBy({ userId: LOLA }), { userId: LOLA }, NOW)).toBe(true);
    expect(isFreshTopUpBy(cashBy({ userId: LOLA }), { userId: 'otra' }, NOW)).toBe(false);
    expect(isFreshTopUpBy(cashBy({ terminalId: RECEPCION }), { terminalId: RECEPCION }, NOW)).toBe(true);
    expect(isFreshTopUpBy(cashBy({ terminalId: RECEPCION }), { terminalId: 'term-barra' }, NOW)).toBe(false);
    // Una recarga de una persona no abre la puerta a un datáfono (ni al revés).
    expect(isFreshTopUpBy(cashBy({ userId: LOLA }), { terminalId: RECEPCION }, NOW)).toBe(false);
  });

  it('pasados los 15 min, sin pagar todavía o sin recarga: no', () => {
    const old = new Date(NOW.getTime() - FRESH_TOPUP_MS - 1);
    expect(isFreshTopUpBy(cashBy({ userId: LOLA, at: old }), { userId: LOLA }, NOW)).toBe(false);
    expect(isFreshTopUpBy(cashBy({ userId: LOLA, at: new Date(NOW.getTime() - FRESH_TOPUP_MS) }), { userId: LOLA }, NOW)).toBe(true);
    expect(isFreshTopUpBy(cashBy({ userId: LOLA, at: null }), { userId: LOLA }, NOW)).toBe(false);
    expect(isFreshTopUpBy(null, { userId: LOLA }, NOW)).toBe(false);
  });
});
