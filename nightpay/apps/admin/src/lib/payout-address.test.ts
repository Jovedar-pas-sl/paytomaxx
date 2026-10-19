import { describe, expect, it } from 'vitest';
import {
  isAutoVerifiable,
  isValidIban,
  normalizePayoutAddress,
  payoutAddressError,
  payoutValue,
  payoutValueFromSaved,
  touchesPayoutAccount,
} from './payout-address';
import { changedFields } from './diff';

describe('isValidIban', () => {
  it('acepta IBAN correctos, con o sin espacios', () => {
    expect(isValidIban('ES91 2100 0418 4502 0005 1332')).toBe(true);
    expect(isValidIban('es9121000418450200051332')).toBe(true);
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
  });

  it('rechaza un dígito cambiado o una forma que no es IBAN', () => {
    expect(isValidIban('ES91 2100 0418 4502 0005 1333')).toBe(false);
    expect(isValidIban('1234')).toBe(false);
    expect(isValidIban('')).toBe(false);
  });
});

describe('payoutAddressError', () => {
  it('Tron TRC20: T + 33 caracteres base58', () => {
    expect(payoutAddressError('USDT_TRC20', `T${'A'.repeat(33)}`)).toBeNull();
    expect(payoutAddressError('USDT_TRC20', `T${'A'.repeat(32)}`)).toMatch(/Tron/);
    expect(payoutAddressError('USDT_TRC20', `T${'0'.repeat(33)}`)).toMatch(/Tron/); // 0 no es base58
    expect(payoutAddressError('USDT_TRC20', `0x${'a'.repeat(40)}`)).toMatch(/Tron/);
  });

  it('EVM (BEP20 / Polygon): 0x + 40 hexadecimales', () => {
    expect(payoutAddressError('USDT_BEP20', `0x${'aB3'.repeat(13)}c`)).toBeNull();
    expect(payoutAddressError('USDC_POLY', `0x${'g'.repeat(40)}`)).toMatch(/0x/);
    expect(payoutAddressError('USDC_POLY', `0x${'a'.repeat(39)}`)).toMatch(/0x/);
  });

  it('Solana: base58 de 32 a 44', () => {
    expect(payoutAddressError('USDC_SOL', 'So11111111111111111111111111111111111111112')).toBeNull();
    expect(payoutAddressError('USDC_SOL', 'corta')).toMatch(/Solana/);
    expect(payoutAddressError('USDC_SOL', `${'1'.repeat(31)}O`)).toMatch(/Solana/);
  });

  it('IBAN SEPA con dígito de control', () => {
    expect(payoutAddressError('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1332')).toBeNull();
    expect(payoutAddressError('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1333')).toMatch(/IBAN/);
  });

  it('wire internacional: si parece IBAN se comprueba; si es un número de cuenta, vale', () => {
    expect(payoutAddressError('WIRE_INTERNATIONAL', 'GE29 NB00 0000 0101 9049 17')).toBeNull();
    expect(payoutAddressError('WIRE_INTERNATIONAL', 'GE29 NB00 0000 0101 9049 18')).toMatch(/IBAN/);
    expect(payoutAddressError('WIRE_INTERNATIONAL', '0012345678')).toBeNull();
  });

  it('métodos por email', () => {
    expect(payoutAddressError('PAYONEER_EMAIL', 'ana@ejemplo.com')).toBeNull();
    expect(payoutAddressError('FASTERPAY_EMAIL', 'ana@')).toMatch(/Email/);
  });

  it('efectivo no pide dirección; el resto, sí', () => {
    expect(payoutAddressError('MANUAL_CASH', '')).toBeNull();
    expect(payoutAddressError(null, '')).toBeNull();
    expect(payoutAddressError('BINANCE_PAY_ID', '   ')).toMatch(/Falta/);
    expect(payoutAddressError('BINANCE_PAY_ID', '123456789')).toBeNull();
  });
});

describe('normalizePayoutAddress', () => {
  it('IBAN junto y en mayúsculas; el resto solo sin espacios alrededor', () => {
    expect(normalizePayoutAddress('SEPA_IBAN', ' es91 2100 0418 4502 0005 1332 ')).toBe('ES9121000418450200051332');
    expect(normalizePayoutAddress('USDT_BEP20', ` 0x${'a'.repeat(40)} `)).toBe(`0x${'a'.repeat(40)}`);
    expect(normalizePayoutAddress('WIRE_INTERNATIONAL', '0012 3456')).toBe('0012 3456');
  });
});

describe('isAutoVerifiable', () => {
  it('solo las redes cripto', () => {
    expect(isAutoVerifiable('USDT_TRC20')).toBe(true);
    expect(isAutoVerifiable('SEPA_IBAN')).toBe(false);
    expect(isAutoVerifiable(null)).toBe(false);
  });
});

describe('payoutValue', () => {
  it('efectivo no lleva dirección aunque quede escrita de antes', () => {
    expect(payoutValue('MANUAL_CASH', 'ES91 2100', 'caja', null)).toEqual({
      method: 'MANUAL_CASH',
      address: null,
      metadata: null,
      label: 'caja',
    });
  });

  it('wire: solo los datos del banco rellenos', () => {
    expect(payoutValue('WIRE_INTERNATIONAL', '0012', '', { bankName: ' TBC ', swiftBic: '', country: 'Georgia' })).toEqual({
      method: 'WIRE_INTERNATIONAL',
      address: '0012',
      metadata: { bankName: 'TBC', country: 'Georgia' },
      label: null,
    });
  });

  it('el formulario sin tocar no cambia nada frente a lo guardado', () => {
    const saved = {
      payoutMethod: 'WIRE_INTERNATIONAL' as const,
      payoutAddress: 'GE29NB0000000101904917',
      payoutMetadata: { bankName: 'TBC' },
      payoutLabel: 'TBC Camila',
    };
    const form = payoutValue('WIRE_INTERNATIONAL', 'GE29 NB00 0000 0101 9049 17', 'TBC Camila ', {
      bankName: 'TBC',
      swiftBic: '',
      country: '',
      accountHolder: '',
    });
    expect(changedFields(payoutValueFromSaved(saved), form)).toEqual({});
  });
});

describe('touchesPayoutAccount', () => {
  it('método, dirección, datos o etiqueta de cobro → sí (también a null); nombre o comisión → no', () => {
    expect(touchesPayoutAccount({ payoutAddress: 'ES91…' })).toBe(true);
    expect(touchesPayoutAccount({ payoutMethod: null })).toBe(true);
    expect(touchesPayoutAccount({ payoutMetadata: { network: 'TRC20' } })).toBe(true);
    expect(touchesPayoutAccount({ payoutLabel: 'Binance' })).toBe(true);
    expect(touchesPayoutAccount({ displayName: 'Ana', commissionBps: 8500 } as never)).toBe(false);
    expect(touchesPayoutAccount({})).toBe(false);
  });
});
