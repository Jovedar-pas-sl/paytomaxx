import { describe, expect, it, vi } from 'vitest';
import { firstName, latestTopUp, paidTopUpMethod, recentTopUp } from './recent-topup';

const NOW = new Date('2026-11-10T01:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const SERGIO = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';

describe('la última recarga en la fila de la ficha (A4)', () => {
  it('solo el nombre de pila; sin nombre, nada (nunca el email)', () => {
    expect(firstName('Sergio García')).toBe('Sergio');
    expect(firstName('  Ana  ')).toBe('Ana');
    expect(firstName('')).toBeNull();
    expect(firstName(null)).toBeNull();
  });

  it('la más reciente de las de los últimos 10 minutos', () => {
    const cash = { at: ago(2), amountCents: 5_000, method: 'cash' as const, byUserId: SERGIO };
    const card = { at: ago(5), amountCents: 2_000, method: 'card' as const, byUserId: null };
    expect(latestTopUp([card, cash], NOW)).toBe(cash);
    expect(latestTopUp([{ ...cash, at: ago(11) }, null], NOW)).toBeNull();
    expect(latestTopUp([{ ...cash, at: ago(10) }], NOW)).not.toBeNull();
  });

  it('lee las recargas que ya existen: efectivo sin anular y tarjeta pagada', async () => {
    const tx = {
      walletCashTopUp: { findFirst: vi.fn(async () => ({ createdAt: ago(2), amountCents: 5_000, takenByUserId: SERGIO })) },
      payment: { findFirst: vi.fn(async () => ({ authorizedAt: ago(8), amountCents: 2_000, createdByUserId: null })) },
      user: { findUnique: vi.fn(async () => ({ displayName: 'Sergio García', email: 'sergio@local.es' })) },
    };
    const out = await recentTopUp(tx as never, 'w-1', NOW);
    expect(out).toEqual({ at: ago(2).toISOString(), amountCents: 5_000, method: 'cash', byName: 'Sergio' });
    expect(JSON.stringify(out)).not.toContain('@');
    const cashWhere = (tx.walletCashTopUp.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(cashWhere).toMatchObject({ walletId: 'w-1', voidOfId: null, voidedBy: { is: null } });
    const cardWhere = (tx.payment.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(cardWhere).toMatchObject({ walletId: 'w-1', status: 'AUTHORIZED' });
  });

  it('sin recargas recientes, null (y no pregunta por nadie)', async () => {
    const tx = {
      walletCashTopUp: { findFirst: vi.fn(async () => null) },
      payment: { findFirst: vi.fn(async () => null) },
      user: { findUnique: vi.fn() },
    };
    await expect(recentTopUp(tx as never, 'w-1', NOW)).resolves.toBeNull();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });

  it('desde el móvil del cliente o el datáfono (sin persona): sin nombre', async () => {
    const tx = {
      walletCashTopUp: { findFirst: vi.fn(async () => null) },
      payment: { findFirst: vi.fn(async () => ({ authorizedAt: ago(1), amountCents: 3_000, createdByUserId: null })) },
      user: { findUnique: vi.fn() },
    };
    await expect(recentTopUp(tx as never, 'w-1', NOW)).resolves.toEqual({ at: ago(1).toISOString(), amountCents: 3_000, method: 'card', byName: null });
  });

  it('pagada con bitcoin (BTCPay): «con bitcoin», no «con tarjeta»', async () => {
    const tx = {
      walletCashTopUp: { findFirst: vi.fn(async () => null) },
      payment: { findFirst: vi.fn(async () => ({ authorizedAt: ago(2), amountCents: 5_000, createdByUserId: null, provider: 'BTCPAY' })) },
      user: { findUnique: vi.fn() },
    };
    await expect(recentTopUp(tx as never, 'w-1', NOW)).resolves.toMatchObject({ amountCents: 5_000, method: 'bitcoin' });
    expect(paidTopUpMethod('REDSYS')).toBe('card');
    expect(paidTopUpMethod(null)).toBe('card');
  });
});
