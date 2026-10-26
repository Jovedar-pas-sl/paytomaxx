import { describe, expect, it } from 'vitest';
import {
  SelfOnboardingSubmitSchema,
  UpdateOperatorSchema,
  isValidSwiftBic,
  normalizePayoutAddress,
  normalizeWireDetails,
  payoutFormatProblem,
  wireDetailsProblems,
} from '@nightpay/contracts';

/**
 * El alta por enlace: cada método de cobro con su forma (la chica teclea en el
 * móvil; un dato mal puesto y su dinero no le llega). El panel del dueño sigue
 * con las reglas de siempre (y no se revalida lo ya guardado).
 */

const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const EVM = '0x55d398326f99059ff775485246999027b3197955';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const IBAN = 'ES91 2100 0418 4502 0005 1332';
const GE_IBAN = 'GE29 NB00 0000 0101 9049 17';
const WIRE = { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', country: 'Georgia', accountHolder: 'Camila Pérez' };

describe('payoutFormatProblem — la forma de cada método', () => {
  it('cripto e IBAN SEPA: las reglas de siempre (red, longitud, dígito de control)', () => {
    expect(payoutFormatProblem('USDT_TRC20', TRON)).toBeNull();
    expect(payoutFormatProblem('USDT_TRC20', EVM)).toMatch(/Tron/);
    expect(payoutFormatProblem('USDT_BEP20', EVM)).toBeNull();
    expect(payoutFormatProblem('USDC_POLY', TRON)).toMatch(/0x/);
    expect(payoutFormatProblem('USDC_SOL', SOL)).toBeNull();
    expect(payoutFormatProblem('SEPA_IBAN', IBAN)).toBeNull();
    expect(payoutFormatProblem('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1333')).toMatch(/IBAN/);
  });

  it('Solana: además, una clave de 32 bytes (una dirección de Tron o de Bitcoin pegada aquí no vale)', () => {
    // La de Tron también es base58 y cabe en 32-44 caracteres, pero son 25 bytes.
    expect(payoutFormatProblem('USDC_SOL', TRON)).toMatch(/Solana/);
    expect(payoutFormatProblem('USDC_SOL', 'abc'.repeat(11))).toMatch(/Solana/);
    expect(payoutFormatProblem('USDC_SOL', 'So11111111111111111111111111111111111111112')).toBeNull();
  });

  it('Binance Pay ID: solo números', () => {
    expect(payoutFormatProblem('BINANCE_PAY_ID', '123456789')).toBeNull();
    expect(payoutFormatProblem('BINANCE_PAY_ID', ' 123 456 789 ')).toBeNull();
    expect(payoutFormatProblem('BINANCE_PAY_ID', 'ana@binance')).toMatch(/números/);
    expect(payoutFormatProblem('BINANCE_PAY_ID', '12')).toMatch(/números/);
  });

  it('OKX y Bybit: su UID (números), o el email o el teléfono de la cuenta', () => {
    expect(payoutFormatProblem('OKX_INTERNAL', '3412345678901234')).toBeNull();
    expect(payoutFormatProblem('BYBIT_INTERNAL', '12345678')).toBeNull();
    expect(payoutFormatProblem('OKX_INTERNAL', 'ana@example.com')).toBeNull();
    expect(payoutFormatProblem('BYBIT_INTERNAL', '+34 600 11 22 33')).toBeNull();
    expect(payoutFormatProblem('OKX_INTERNAL', 'mi cuenta de okx')).toMatch(/UID/);
  });

  it('emails: un email de verdad', () => {
    expect(payoutFormatProblem('PAYONEER_EMAIL', 'ana@example.com')).toBeNull();
    expect(payoutFormatProblem('FASTERPAY_EMAIL', 'ana@example')).toMatch(/email/);
  });

  it('Hyperwallet: el token (usr-…) o el email', () => {
    expect(payoutFormatProblem('HYPERWALLET_TOKEN', 'usr-c4292f1a-866f-4310-a289-b916853939de')).toBeNull();
    expect(payoutFormatProblem('HYPERWALLET_TOKEN', 'ana@example.com')).toBeNull();
    expect(payoutFormatProblem('HYPERWALLET_TOKEN', 'ana')).toMatch(/Hyperwallet/);
  });

  it('Revolut: el @tag o el teléfono', () => {
    expect(payoutFormatProblem('REVOLUT_TAG', '@ana123')).toBeNull();
    expect(payoutFormatProblem('REVOLUT_TAG', '+34600112233')).toBeNull();
    expect(payoutFormatProblem('REVOLUT_TAG', 'ana123')).toMatch(/@tag/);
  });

  it('MercadoPago: CVU/CBU de 22 números o el alias', () => {
    expect(payoutFormatProblem('MERCADOPAGO_CVU', '0000003100012345678901')).toBeNull();
    expect(payoutFormatProblem('MERCADOPAGO_CVU', '0000003100 0123456789 01')).toBeNull();
    expect(payoutFormatProblem('MERCADOPAGO_CVU', 'ana.lopez.mp')).toBeNull();
    expect(payoutFormatProblem('MERCADOPAGO_CVU', '000000310001234567890')).toMatch(/22/);
    expect(payoutFormatProblem('MERCADOPAGO_CVU', 'mi alias')).toMatch(/22/);
  });

  it('Pix: CPF, CNPJ, teléfono, email o la clave aleatoria', () => {
    expect(payoutFormatProblem('PIX_KEY', '123.456.789-09')).toBeNull();
    expect(payoutFormatProblem('PIX_KEY', '12.345.678/0001-95')).toBeNull();
    expect(payoutFormatProblem('PIX_KEY', '+55 11 99999-9999')).toBeNull();
    expect(payoutFormatProblem('PIX_KEY', 'ana@example.com')).toBeNull();
    expect(payoutFormatProblem('PIX_KEY', '7d9f4a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6')).toBeNull();
    expect(payoutFormatProblem('PIX_KEY', 'mi pix')).toMatch(/Pix/);
    expect(payoutFormatProblem('PIX_KEY', '+34 600 11 22 33')).toMatch(/Pix/);
  });

  it('Nequi y Daviplata: móvil de Colombia (10 números que empiezan por 3, con o sin +57)', () => {
    expect(payoutFormatProblem('NEQUI_PHONE', '3001234567')).toBeNull();
    expect(payoutFormatProblem('DAVIPLATA_PHONE', '+57 300 123 4567')).toBeNull();
    expect(payoutFormatProblem('NEQUI_PHONE', '+34600112233')).toMatch(/Colombia/);
    expect(payoutFormatProblem('DAVIPLATA_PHONE', '600112233')).toMatch(/Colombia/);
  });

  it('transferencia internacional: IBAN con su dígito de control, o un número de cuenta', () => {
    expect(payoutFormatProblem('WIRE_INTERNATIONAL', GE_IBAN)).toBeNull();
    expect(payoutFormatProblem('WIRE_INTERNATIONAL', 'GE29 NB00 0000 0101 9049 18')).toMatch(/IBAN/);
    expect(payoutFormatProblem('WIRE_INTERNATIONAL', '0012345678')).toBeNull();
    expect(payoutFormatProblem('WIRE_INTERNATIONAL', '¿?')).toMatch(/cuenta/);
    expect(normalizePayoutAddress('WIRE_INTERNATIONAL', ' ge29 nb00 0000 0101 9049 17 ')).toBe('GE29NB0000000101904917');
    expect(normalizePayoutAddress('WIRE_INTERNATIONAL', ' 0012 3456 ')).toBe('0012 3456');
  });

  it('efectivo en mano: sin dirección', () => {
    expect(payoutFormatProblem('MANUAL_CASH', '')).toBeNull();
  });
});

describe('datos del banco de la transferencia internacional', () => {
  it('SWIFT/BIC: 8 u 11, con el país en medio', () => {
    expect(isValidSwiftBic('TBCBGE22')).toBe(true);
    expect(isValidSwiftBic('deutdeff500')).toBe(true);
    expect(isValidSwiftBic('DEUT DE FF')).toBe(true);
    expect(isValidSwiftBic('TBCB22')).toBe(false);
    expect(isValidSwiftBic('TBCBGE2')).toBe(false);
    expect(isValidSwiftBic('1BCBGE22')).toBe(false);
  });

  it('banco, SWIFT y titular, obligatorios; el país, no', () => {
    expect(wireDetailsProblems(WIRE)).toEqual([]);
    expect(wireDetailsProblems({ ...WIRE, country: '' })).toEqual([]);
    expect(wireDetailsProblems(null).map((p) => p.field)).toEqual(['bankName', 'swiftBic', 'accountHolder']);
    expect(wireDetailsProblems({ ...WIRE, swiftBic: 'TBCB' })).toEqual([{ field: 'swiftBic', message: expect.stringMatching(/SWIFT/) }]);
  });

  it('se guardan limpios: SWIFT junto y en mayúsculas, sin campos vacíos', () => {
    expect(normalizeWireDetails({ bankName: ' TBC Bank ', swiftBic: 'tbcb ge 22', country: '', accountHolder: ' Camila ' })).toEqual({
      bankName: 'TBC Bank',
      swiftBic: 'TBCBGE22',
      accountHolder: 'Camila',
    });
    expect(normalizeWireDetails(null)).toBeNull();
  });
});

describe('SelfOnboardingSubmitSchema — el alta por enlace', () => {
  const ok = (body: Record<string, unknown>) => SelfOnboardingSubmitSchema.safeParse(body).success;
  const paths = (body: Record<string, unknown>) => {
    const r = SelfOnboardingSubmitSchema.safeParse(body);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('SWIFT sin los datos del banco no se guarda; con ellos, sí', () => {
    expect(paths({ payoutMethod: 'WIRE_INTERNATIONAL', payoutAddress: GE_IBAN })).toEqual([
      'payoutMetadata.bankName',
      'payoutMetadata.swiftBic',
      'payoutMetadata.accountHolder',
    ]);
    expect(ok({ payoutMethod: 'WIRE_INTERNATIONAL', payoutAddress: GE_IBAN, payoutMetadata: WIRE })).toBe(true);
  });

  it('con método, la cuenta es obligatoria (salvo efectivo); sin método («No sé todavía»), nada', () => {
    expect(paths({ payoutMethod: 'PIX_KEY', payoutAddress: null })).toEqual(['payoutAddress']);
    expect(paths({ payoutMethod: 'NEQUI_PHONE' })).toEqual(['payoutAddress']);
    expect(ok({ payoutMethod: 'MANUAL_CASH', payoutAddress: null })).toBe(true);
    expect(ok({ payoutMethod: null, payoutAddress: null })).toBe(true);
    expect(ok({ phone: '600000000' })).toBe(true);
  });

  it('cada método con su forma', () => {
    expect(paths({ payoutMethod: 'NEQUI_PHONE', payoutAddress: '+34600112233' })).toEqual(['payoutAddress']);
    expect(ok({ payoutMethod: 'NEQUI_PHONE', payoutAddress: '300 123 4567' })).toBe(true);
    expect(paths({ payoutMethod: 'USDT_TRC20', payoutAddress: EVM })).toEqual(['payoutAddress']);
  });

  it('el panel del dueño sigue con las reglas de siempre (lo guardado no se revalida)', () => {
    expect(UpdateOperatorSchema.safeParse({ payoutMethod: 'WIRE_INTERNATIONAL', payoutAddress: GE_IBAN }).success).toBe(true);
    expect(UpdateOperatorSchema.safeParse({ payoutMethod: 'NEQUI_PHONE', payoutAddress: 'cualquier cosa' }).success).toBe(true);
    expect(UpdateOperatorSchema.safeParse({ payoutLabel: 'Mi banco' }).success).toBe(true);
  });
});
