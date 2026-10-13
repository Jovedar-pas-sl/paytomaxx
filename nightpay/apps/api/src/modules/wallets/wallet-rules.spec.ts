import { describe, it, expect } from 'vitest';
import {
  allocateCardRefund,
  decideAccept,
  effectiveRequestStatus,
  formatWalletCode,
  newWalletCode,
  normalizeWalletCode,
  sameWalletGroup,
} from './wallet-rules';

const NOW = new Date('2026-10-13T23:00:00Z');
const later = new Date(NOW.getTime() + 60_000);
const before = new Date(NOW.getTime() - 1);

describe('código del cliente', () => {
  it('6 caracteres sin letras que se confunden; se teclea como sea', () => {
    for (let i = 0; i < 50; i += 1) expect(newWalletCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(normalizeWalletCode(' k7q-4m2 ')).toBe('K7Q4M2');
    expect(formatWalletCode('K7Q4M2')).toBe('K7Q-4M2');
  });
});

describe('saldo en todos los locales del dueño', () => {
  it('mismo local o mismo grupo → sí; otro grupo o sin grupo → no', () => {
    const wallet = { tenantId: 'a', walletGroup: 'principal' };
    expect(sameWalletGroup(wallet, { id: 'a', walletGroup: null })).toBe(true);
    expect(sameWalletGroup(wallet, { id: 'b', walletGroup: 'principal' })).toBe(true);
    expect(sameWalletGroup(wallet, { id: 'c', walletGroup: 'otro' })).toBe(false);
    expect(sameWalletGroup({ tenantId: 'a', walletGroup: null }, { id: 'b', walletGroup: null })).toBe(false);
  });
});

describe('el cliente acepta cada gasto en su móvil', () => {
  const pending = { status: 'PENDING', expiresAt: later, amountCents: 10_000 };

  it('pendiente, saldo suficiente → se acepta', () => {
    expect(decideAccept(pending, { status: 'ACTIVE', balanceCents: 10_000 }, NOW)).toEqual({ ok: true });
  });

  it('caducada, ya decidida, wallet cerrada o sin saldo → no', () => {
    expect(effectiveRequestStatus({ status: 'PENDING', expiresAt: before }, NOW)).toBe('EXPIRED');
    expect(decideAccept({ ...pending, expiresAt: before }, { status: 'ACTIVE', balanceCents: 99_999 }, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(decideAccept({ ...pending, status: 'REJECTED' }, { status: 'ACTIVE', balanceCents: 99_999 }, NOW)).toEqual({
      ok: false,
      reason: 'not-pending',
    });
    expect(decideAccept(pending, { status: 'REFUNDED', balanceCents: 99_999 }, NOW)).toEqual({
      ok: false,
      reason: 'wallet-closed',
    });
    expect(decideAccept(pending, { status: 'ACTIVE', balanceCents: 9_999 }, NOW)).toEqual({
      ok: false,
      reason: 'insufficient',
    });
  });
});

describe('devolver el saldo a la tarjeta', () => {
  it('se reparte entre las recargas, la más reciente primero', () => {
    expect(
      allocateCardRefund(
        [
          { paymentId: 'nueva', availableAmountCents: 5000 },
          { paymentId: 'vieja', availableAmountCents: 10_000 },
        ],
        8000,
      ),
    ).toEqual([
      { paymentId: 'nueva', amountCents: 5000 },
      { paymentId: 'vieja', amountCents: 3000 },
    ]);
  });

  it('si las recargas no cubren el saldo → nada (hay que mirarlo a mano)', () => {
    expect(allocateCardRefund([{ paymentId: 'x', availableAmountCents: 1000 }], 2000)).toEqual([]);
  });
});
