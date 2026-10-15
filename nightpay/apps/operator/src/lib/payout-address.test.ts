import { describe, expect, it } from 'vitest';
import { isValidIban, needsPayoutConfirmation, payoutAddressProblem, payoutFormProblem } from './payout-address';

describe('dirección de cobro según el método', () => {
  it('USDT en Tron (TRC20): T + 33 caracteres base58', () => {
    expect(payoutAddressProblem('USDT_TRC20', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toBeNull();
    expect(payoutAddressProblem('USDT_TRC20', ' TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV ')).toBeNull();
    expect(payoutAddressProblem('USDT_TRC20', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFi')).toMatch(/Tron/);
    // 0, O, I y l no existen en base58.
    expect(payoutAddressProblem('USDT_TRC20', 'T0YZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toMatch(/Tron/);
    expect(payoutAddressProblem('USDT_TRC20', '0x52908400098527886E0F7030069857D2E4169EE7')).toMatch(/Tron/);
  });

  it('BSC y Polygon (EVM): 0x + 40 hexadecimales', () => {
    const evm = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(payoutAddressProblem('USDT_BEP20', evm)).toBeNull();
    expect(payoutAddressProblem('USDC_POLY', evm.toLowerCase())).toBeNull();
    expect(payoutAddressProblem('USDT_BEP20', evm.slice(0, -1))).toMatch(/0x/);
    expect(payoutAddressProblem('USDC_POLY', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toMatch(/0x/);
  });

  it('IBAN: formato y dígitos de control (mod 97)', () => {
    expect(isValidIban('ES9121000418450200051332')).toBe(true);
    expect(isValidIban('es91 2100 0418 4502 0005 1332')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
    expect(isValidIban('ES9121000418450200051333')).toBe(false);
    expect(isValidIban('ES91')).toBe(false);
    expect(payoutAddressProblem('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1333')).toMatch(/IBAN/);
    expect(payoutAddressProblem('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1332')).toBeNull();
  });

  it('emails donde el método es un email; el resto no se comprueba aquí', () => {
    expect(payoutAddressProblem('PAYONEER_EMAIL', 'ana@example.com')).toBeNull();
    expect(payoutAddressProblem('PAYONEER_EMAIL', 'ana@example')).toMatch(/email/);
    expect(payoutAddressProblem('BINANCE_PAY_ID', '123456789')).toBeNull();
    expect(payoutAddressProblem('MANUAL_CASH', '')).toBeNull();
  });

  it('vacía no es un error (el método de cobro es opcional)', () => {
    expect(payoutAddressProblem('USDT_TRC20', '   ')).toBeNull();
  });
});

describe('repetir la dirección para confirmarla', () => {
  it('solo si es nueva o ha cambiado (sin contar espacios, ni mayúsculas en el IBAN)', () => {
    expect(needsPayoutConfirmation('USDT_TRC20', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV', null)).toBe(true);
    expect(
      needsPayoutConfirmation('USDT_TRC20', ' TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV'),
    ).toBe(false);
    expect(needsPayoutConfirmation('SEPA_IBAN', 'es91 2100 0418 4502 0005 1332', 'ES9121000418450200051332')).toBe(false);
    expect(needsPayoutConfirmation('USDT_TRC20', '', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toBe(false);
  });
});

describe('antes de guardar', () => {
  const trc = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
  it('dirección nueva: tiene que estar bien escrita y repetida igual', () => {
    expect(payoutFormProblem('USDT_TRC20', trc, trc, null)).toBeNull();
    expect(payoutFormProblem('USDT_TRC20', trc, `${trc.slice(0, -1)}W`, null)).toMatch(/no coinciden/);
    expect(payoutFormProblem('USDT_TRC20', 'Txx', 'Txx', null)).toMatch(/Tron/);
  });
  it('la de siempre, sin cambios: no hace falta repetirla', () => {
    expect(payoutFormProblem('USDT_TRC20', trc, '', trc)).toBeNull();
    expect(payoutFormProblem('', '', '', null)).toBeNull();
  });
});
