import { describe, expect, it } from 'vitest';
import {
  PAYOUT_ACCOUNT_HOLD_HOURS,
  SelfOnboardingSubmitSchema,
  holderMatchesName,
  maskHolderName,
  payoutHolderProblem,
  payoutHolderRequired,
} from '@nightpay/contracts';

const IBAN = 'ES91 2100 0418 4502 0005 1332';

describe('titular de la cuenta: obligatorio en el IBAN SEPA y en la transferencia internacional', () => {
  it('SEPA y SWIFT lo piden; los demás métodos, no', () => {
    expect(payoutHolderRequired('SEPA_IBAN')).toBe(true);
    expect(payoutHolderRequired('WIRE_INTERNATIONAL')).toBe(true);
    expect(payoutHolderRequired('USDT_TRC20')).toBe(false);
    expect(payoutHolderRequired('MANUAL_CASH')).toBe(false);
    expect(payoutHolderRequired(null)).toBe(false);
  });

  it('sin titular (o solo espacios) → el motivo; con titular, nada', () => {
    expect(payoutHolderProblem('SEPA_IBAN', null)).toBe('Falta el titular de la cuenta');
    expect(payoutHolderProblem('SEPA_IBAN', { accountHolder: '   ' })).toBe('Falta el titular de la cuenta');
    expect(payoutHolderProblem('SEPA_IBAN', { accountHolder: 'Ana López' })).toBeNull();
    expect(payoutHolderProblem('PIX_KEY', null)).toBeNull();
  });

  it('el alta por enlace no guarda un IBAN SEPA sin titular', () => {
    const r = SelfOnboardingSubmitSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN });
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual(['payoutMetadata.accountHolder']);
    expect(
      SelfOnboardingSubmitSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Ana López' } })
        .success,
    ).toBe(true);
  });
});

describe('titular tapado para los listados', () => {
  it('la inicial de cada palabra', () => {
    expect(maskHolderName('María López García')).toBe('M••• L••• G•••');
    expect(maskHolderName('  ana   de la  fuente ')).toBe('A••• D••• L••• F•••');
    expect(maskHolderName('Ñ')).toBe('Ñ•••');
  });
  it('sin titular → null', () => {
    expect(maskHolderName(null)).toBeNull();
    expect(maskHolderName('   ')).toBeNull();
  });
});

describe('¿el titular se parece al nombre de la compañera? (aviso, no bloquea)', () => {
  it('una palabra en común (sin acentos ni mayúsculas) → sí', () => {
    expect(holderMatchesName('María López García', 'Maria')).toBe(true);
    expect(holderMatchesName('ANA MARIA LOPEZ', 'Ana')).toBe(true);
    expect(holderMatchesName('Alejandra Ruiz', 'Ale')).toBe(true);
    expect(holderMatchesName('Svetlana Ivanova', 'Lana Ivanova')).toBe(true);
  });
  it('nada en común → no', () => {
    expect(holderMatchesName('Svetlana Ivanova', 'Marina')).toBe(false);
    expect(holderMatchesName('Juan Pérez', 'Ana')).toBe(false);
  });
  it('sin nombre o sin titular no se puede comparar: no se avisa', () => {
    expect(holderMatchesName('Juan Pérez', null)).toBe(true);
    expect(holderMatchesName(null, 'Ana')).toBe(true);
    expect(holderMatchesName('Juan Pérez', '  ')).toBe(true);
  });
  it('palabras de una o dos letras no cuentan (de, la, M.)', () => {
    expect(holderMatchesName('Juan de la Cruz', 'Ana de la Fuente')).toBe(false);
  });
});

describe('espera tras cambiar la cuenta', () => {
  it('48 h', () => {
    expect(PAYOUT_ACCOUNT_HOLD_HOURS).toBe(48);
  });
});
