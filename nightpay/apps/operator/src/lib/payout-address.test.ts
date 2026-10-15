import { describe, expect, it } from 'vitest';
import {
  isValidIban,
  needsPayoutConfirmation,
  payoutAddressProblem,
  payoutChanged,
  payoutFormProblem,
} from './payout-address';

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
  const nothingSaved = { method: null, address: null };
  it('dirección nueva: tiene que estar bien escrita y repetida igual', () => {
    expect(payoutFormProblem('USDT_TRC20', trc, trc, nothingSaved)).toBeNull();
    expect(payoutFormProblem('USDT_TRC20', trc, `${trc.slice(0, -1)}W`, nothingSaved)).toMatch(/no coinciden/);
    expect(payoutFormProblem('USDT_TRC20', 'Txx', 'Txx', nothingSaved)).toMatch(/Tron/);
  });
  it('la de siempre, sin cambios: no hace falta repetirla', () => {
    expect(payoutFormProblem('USDT_TRC20', trc, '', { method: 'USDT_TRC20', address: trc })).toBeNull();
    expect(payoutFormProblem('', '', '', nothingSaved)).toBeNull();
  });
  it('método vuelto a «No sé todavía»: ni dirección ni repetición que comprobar', () => {
    expect(payoutFormProblem('', trc, '', nothingSaved)).toBeNull();
    expect(payoutFormProblem('', 'lo que sea', 'otra cosa', { method: 'USDT_TRC20', address: trc })).toBeNull();
  });
  it('una dirección antigua guardada que no pasa el formato no bloquea si no se toca', () => {
    const legacy = { method: 'USDT_TRC20' as const, address: 'Tvieja-mal-escrita' };
    expect(payoutFormProblem('USDT_TRC20', 'Tvieja-mal-escrita', '', legacy)).toBeNull();
    // Cambiar el método (o la dirección) sí la comprueba.
    expect(payoutFormProblem('USDT_BEP20', 'Tvieja-mal-escrita', '', legacy)).toMatch(/0x/);
    expect(payoutChanged('USDT_TRC20', ' Tvieja-mal-escrita ', legacy)).toBe(false);
    expect(payoutChanged('USDT_TRC20', 'Tnueva', legacy)).toBe(true);
  });
});
