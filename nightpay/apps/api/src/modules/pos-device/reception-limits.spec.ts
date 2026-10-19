import { describe, it, expect } from 'vitest';
import { DEFAULT_TERMINAL_DAILY_CAP_CENTS, DEFAULT_WALLET_DAILY_CAP_CENTS, receptionCaps, receptionLimitHit } from './reception-limits';

describe('topes de 24 h de la recepción (seguridad #3)', () => {
  it('por defecto 15.000 € por datáfono y 5.000 € por saldo; se cambian en euros por env', () => {
    expect(receptionCaps({})).toEqual({ terminalCents: DEFAULT_TERMINAL_DAILY_CAP_CENTS, walletCents: DEFAULT_WALLET_DAILY_CAP_CENTS });
    expect(DEFAULT_TERMINAL_DAILY_CAP_CENTS).toBe(1_500_000);
    expect(DEFAULT_WALLET_DAILY_CAP_CENTS).toBe(500_000);
    expect(
      receptionCaps({ POS_RECEPTION_TERMINAL_DAILY_CAP_EUR: '2000', POS_RECEPTION_WALLET_DAILY_CAP_EUR: '300,5' }),
    ).toEqual({ terminalCents: 200_000, walletCents: DEFAULT_WALLET_DAILY_CAP_CENTS });
    expect(receptionCaps({ POS_RECEPTION_TERMINAL_DAILY_CAP_EUR: '0', POS_RECEPTION_WALLET_DAILY_CAP_EUR: ' ' })).toEqual({
      terminalCents: DEFAULT_TERMINAL_DAILY_CAP_CENTS,
      walletCents: DEFAULT_WALLET_DAILY_CAP_CENTS,
    });
  });

  it('justo en el tope vale; un céntimo más, no (primero el del datáfono)', () => {
    const caps = { terminalCents: 10_000, walletCents: 4_000 };
    expect(receptionLimitHit({ amountCents: 1_000, terminalUsedCents: 9_000, walletUsedCents: 3_000, caps })).toBeNull();
    expect(receptionLimitHit({ amountCents: 1_001, terminalUsedCents: 9_000, walletUsedCents: 0, caps })).toBe('terminal_daily');
    expect(receptionLimitHit({ amountCents: 1_001, terminalUsedCents: 0, walletUsedCents: 3_000, caps })).toBe('wallet_daily');
    // Saldo nuevo: solo cuenta el del datáfono.
    expect(receptionLimitHit({ amountCents: 9_000, terminalUsedCents: 0, walletUsedCents: null, caps })).toBeNull();
  });
});
