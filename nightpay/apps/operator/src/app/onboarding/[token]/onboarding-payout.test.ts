import { describe, expect, it } from 'vitest';
import { SelfOnboardingSubmitSchema } from '@nightpay/contracts';
import { EMPTY_PAYOUT, PAYOUT_HINTS, payoutDto, payoutFieldProblems, payoutProblem, type PayoutValues } from './onboarding-payout';

const NOTHING_SAVED = { method: null, address: null };
const GE_IBAN = 'GE29 NB00 0000 0101 9049 17';
const wire = (patch: Partial<PayoutValues> = {}): PayoutValues => ({
  ...EMPTY_PAYOUT,
  method: 'WIRE_INTERNATIONAL',
  address: GE_IBAN,
  confirm: GE_IBAN,
  bankName: 'TBC Bank',
  swiftBic: 'tbcb ge22',
  accountHolder: 'Camila Pérez',
  ...patch,
});

describe('alta: cómo quieres cobrar, con la forma de cada método', () => {
  it('SWIFT pide banco, SWIFT/BIC y titular (el país, no); con ellos se puede guardar', () => {
    const missing = wire({ bankName: '', swiftBic: '', accountHolder: '' });
    expect(payoutFieldProblems(missing, NOTHING_SAVED)).toEqual({
      bankName: 'Falta el nombre del banco',
      swiftBic: 'Falta el SWIFT/BIC del banco',
      accountHolder: 'Falta el titular de la cuenta',
    });
    expect(payoutProblem(missing, NOTHING_SAVED)).toBe('Falta el nombre del banco');
    expect(payoutFieldProblems(wire({ swiftBic: 'TBCB' }), NOTHING_SAVED).swiftBic).toMatch(/8 u 11/);
    expect(payoutProblem(wire(), NOTHING_SAVED)).toBeNull();
  });

  it('lo que se manda: IBAN junto y los datos del banco limpios; el API lo acepta', () => {
    const dto = payoutDto(wire({ label: ' TBC ' }));
    expect(dto).toEqual({
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutAddress: 'GE29NB0000000101904917',
      payoutLabel: 'TBC',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila Pérez' },
    });
    expect(SelfOnboardingSubmitSchema.safeParse(dto).success).toBe(true);
  });

  it('cada método con su forma (lo mismo que comprueba el API)', () => {
    const nequi = (address: string): PayoutValues => ({ ...EMPTY_PAYOUT, method: 'NEQUI_PHONE', address, confirm: address });
    expect(payoutProblem(nequi('+34 600 11 22 33'), NOTHING_SAVED)).toMatch(/Colombia/);
    expect(payoutProblem(nequi('300 123 4567'), NOTHING_SAVED)).toBeNull();
    const cvu = { ...EMPTY_PAYOUT, method: 'MERCADOPAGO_CVU' as const, address: '123', confirm: '123' };
    expect(payoutProblem(cvu, NOTHING_SAVED)).toMatch(/22 números/);
  });

  it('con método, la cuenta es obligatoria (salvo efectivo en mano); sin método, nada que comprobar', () => {
    expect(payoutProblem({ ...EMPTY_PAYOUT, method: 'PIX_KEY' }, NOTHING_SAVED)).toMatch(/Falta la dirección/);
    expect(payoutProblem({ ...EMPTY_PAYOUT, method: 'MANUAL_CASH' }, NOTHING_SAVED)).toBeNull();
    expect(payoutDto({ ...EMPTY_PAYOUT, method: 'MANUAL_CASH', address: 'algo', label: '' })).toEqual({
      payoutMethod: 'MANUAL_CASH',
      payoutAddress: null,
      payoutLabel: null,
    });
    expect(payoutProblem(EMPTY_PAYOUT, NOTHING_SAVED)).toBeNull();
    expect(payoutDto(EMPTY_PAYOUT)).toEqual({ payoutMethod: null, payoutAddress: null, payoutLabel: null });
  });

  it('una dirección nueva se repite; si no coincide, no se guarda', () => {
    const tron = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
    const values: PayoutValues = { ...EMPTY_PAYOUT, method: 'USDT_TRC20', address: tron, confirm: `${tron.slice(0, -1)}X` };
    expect(payoutFieldProblems(values, NOTHING_SAVED).confirm).toMatch(/no coinciden/);
    expect(payoutProblem({ ...values, confirm: tron }, NOTHING_SAVED)).toBeNull();
  });

  it('lo ya guardado y sin tocar no se revalida (no bloquea el resto del alta)', () => {
    const saved = { method: 'NEQUI_PHONE' as const, address: 'formato viejo' };
    expect(payoutProblem({ ...EMPTY_PAYOUT, method: 'NEQUI_PHONE', address: 'formato viejo' }, saved)).toBeNull();
  });

  it('cada método dice qué poner (no una dirección de Tron de ejemplo para todo)', () => {
    expect(PAYOUT_HINTS.SEPA_IBAN.placeholder).toMatch(/^ES/);
    expect(PAYOUT_HINTS.NEQUI_PHONE.placeholder).toMatch(/^\+57/);
    expect(PAYOUT_HINTS.WIRE_INTERNATIONAL.hint).toMatch(/SWIFT/);
  });
});
