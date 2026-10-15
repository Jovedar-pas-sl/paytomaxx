import { describe, it, expect } from 'vitest';
import { TWO_FA_THRESHOLD_CENTS, twoFactorReason } from './refund-two-factor';

const none = { samePaymentCents: 0, lastDayCents: 0 };

describe('twoFactorReason — el 2FA mira lo devuelto acumulado, no cada petición', () => {
  it('por debajo de 100 € en total → no hace falta', () => {
    expect(twoFactorReason(9_999, none)).toBeNull();
    expect(twoFactorReason(4_000, { samePaymentCents: 5_000, lastDayCents: 5_000 })).toBeNull();
  });

  it('una sola de 100 € o más → hace falta', () => {
    expect(twoFactorReason(TWO_FA_THRESHOLD_CENTS, none)).toMatch(/en este cobro sumas 100,00 €/);
  });

  it('99,99 € × N en el MISMO cobro → la que llega a 100 € lo pide', () => {
    expect(twoFactorReason(9_999, { samePaymentCents: 9_999, lastDayCents: 9_999 })).toMatch(
      /en este cobro sumas 199,98 €/,
    );
  });

  it('99,99 € × N en cobros DISTINTOS → lo pide por lo devuelto en 24 h', () => {
    expect(twoFactorReason(9_999, { samePaymentCents: 0, lastDayCents: 9_999 })).toMatch(
      /en las últimas 24 h sumas 199,98 €/,
    );
  });
});
