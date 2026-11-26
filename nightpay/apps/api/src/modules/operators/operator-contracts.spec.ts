import { describe, it, expect } from 'vitest';
import {
  CreatePayoutBatchSchema,
  CreatePayoutSchema,
  PAYOUT_BATCH_MAX_ITEMS,
  PAYOUT_BATCH_PROBLEM_CODES,
  PayoutBatchResultSchema,
  ResetOperatorPasswordSchema,
  SelfOnboardingSubmitSchema,
  UpdateOperatorSchema,
  VerifyPayoutSchema,
  isValidIban,
  normalizePayoutAddress,
  payoutAddressProblem,
} from '@nightpay/contracts';

describe('ResetOperatorPasswordSchema — cuerpo de /admin/operators/:id/reset-password', () => {
  it('sin cuerpo, vacío o sin contraseña → se generará una (password undefined o "")', () => {
    expect(ResetOperatorPasswordSchema.parse(undefined)).toEqual({});
    expect(ResetOperatorPasswordSchema.parse({})).toEqual({});
    expect(ResetOperatorPasswordSchema.parse({ password: '' })).toEqual({ password: '' });
  });

  it('contraseña puesta por el dueño: 8 a 128 caracteres', () => {
    expect(ResetOperatorPasswordSchema.parse({ password: 'Abcdefg1' })).toEqual({ password: 'Abcdefg1' });
    expect(ResetOperatorPasswordSchema.safeParse({ password: 'corta' }).success).toBe(false);
    expect(ResetOperatorPasswordSchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(false);
    expect(ResetOperatorPasswordSchema.safeParse({ password: 12345678 }).success).toBe(false);
  });
});

const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const EVM = '0x55d398326f99059ff775485246999027b3197955';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const IBAN = 'ES91 2100 0418 4502 0005 1332';

describe('isValidIban — formato y dígito de control (mod 97)', () => {
  it('IBAN válidos (con o sin espacios, minúsculas)', () => {
    expect(isValidIban(IBAN)).toBe(true);
    expect(isValidIban('es9121000418450200051332')).toBe(true);
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
  });
  it('dígito de control mal, demasiado corto o con letras raras → no', () => {
    expect(isValidIban('ES91 2100 0418 4502 0005 1333')).toBe(false);
    expect(isValidIban('ES91 2100')).toBe(false);
    expect(isValidIban('ES91-2100-0418-4502-0005-1332')).toBe(false);
    expect(isValidIban('')).toBe(false);
  });
});

describe('payoutAddressProblem — la dirección tiene que ser del método elegido', () => {
  it('USDT-TRC20: T + 33 caracteres base58', () => {
    expect(payoutAddressProblem('USDT_TRC20', TRON)).toBeNull();
    expect(payoutAddressProblem('USDT_TRC20', EVM)).toMatch(/TRC20/);
    expect(payoutAddressProblem('USDT_TRC20', 'T0YZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).not.toBeNull(); // 0 no es base58
  });
  it('USDT-BEP20 y USDC-Polygon: 0x + 40 hex', () => {
    expect(payoutAddressProblem('USDT_BEP20', EVM)).toBeNull();
    expect(payoutAddressProblem('USDC_POLY', EVM.toUpperCase().replace('0X', '0x'))).toBeNull();
    expect(payoutAddressProblem('USDT_BEP20', TRON)).toMatch(/0x/);
    expect(payoutAddressProblem('USDC_POLY', `${EVM}0`)).not.toBeNull();
  });
  it('USDC-Solana: base58 de 32 a 44', () => {
    expect(payoutAddressProblem('USDC_SOL', SOL)).toBeNull();
    expect(payoutAddressProblem('USDC_SOL', EVM)).toMatch(/Solana/);
    expect(payoutAddressProblem('USDC_SOL', 'abc')).not.toBeNull();
  });
  it('SEPA: IBAN con dígito de control', () => {
    expect(payoutAddressProblem('SEPA_IBAN', IBAN)).toBeNull();
    expect(payoutAddressProblem('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1333')).toMatch(/IBAN/);
  });
  it('métodos por email: tiene que ser un email', () => {
    expect(payoutAddressProblem('PAYONEER_EMAIL', 'chica@example.com')).toBeNull();
    expect(payoutAddressProblem('FASTERPAY_EMAIL', 'no-es-email')).toMatch(/email/);
  });
  it('resto de métodos o sin método/dirección → sin regla', () => {
    expect(payoutAddressProblem('BINANCE_PAY_ID', '123456789')).toBeNull();
    expect(payoutAddressProblem('MANUAL_CASH', null)).toBeNull();
    expect(payoutAddressProblem(null, 'lo que sea')).toBeNull();
  });
  it('se normaliza antes de validar/guardar (espacios fuera; IBAN en mayúsculas sin espacios)', () => {
    expect(normalizePayoutAddress('SEPA_IBAN', ' es91 2100 0418 4502 0005 1332 ')).toBe('ES9121000418450200051332');
    expect(normalizePayoutAddress('USDT_TRC20', `  ${TRON} `)).toBe(TRON);
    expect(payoutAddressProblem('USDT_TRC20', ` ${TRON}\n`)).toBeNull();
  });
});

describe('Schemas — método y dirección juntos se validan', () => {
  it('UpdateOperatorSchema rechaza una dirección que no es del método', () => {
    const bad = UpdateOperatorSchema.safeParse({ payoutMethod: 'USDT_TRC20', payoutAddress: EVM });
    expect(bad.success).toBe(false);
    expect(bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'))).toContain('payoutAddress');
    expect(UpdateOperatorSchema.safeParse({ payoutMethod: 'USDT_TRC20', payoutAddress: TRON }).success).toBe(true);
    // Sin el par completo no hay nada que cruzar (lo mira el servicio con lo guardado).
    expect(UpdateOperatorSchema.safeParse({ payoutAddress: EVM }).success).toBe(true);
    expect(UpdateOperatorSchema.safeParse({ displayName: 'Ana' }).success).toBe(true);
  });
  it('SelfOnboardingSubmitSchema igual', () => {
    expect(SelfOnboardingSubmitSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES00 1234' }).success).toBe(false);
    // Con su titular (en SEPA es obligatorio: payout-holder.spec).
    expect(SelfOnboardingSubmitSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Ana López' } }).success).toBe(true);
  });
});

describe('receiptUrl — solo https (javascript: y http: no)', () => {
  it('CreatePayoutSchema y VerifyPayoutSchema', () => {
    for (const receiptUrl of ['javascript:alert(1)', 'http://example.com/r.pdf', 'data:text/html,hola']) {
      expect(CreatePayoutSchema.safeParse({ receiptUrl }).success).toBe(false);
      expect(
        VerifyPayoutSchema.safeParse({ externalTxId: 'abcd1234', externalRail: 'USDT_TRC20', receiptUrl }).success,
      ).toBe(false);
    }
    expect(CreatePayoutSchema.safeParse({ receiptUrl: 'https://example.com/r.pdf' }).success).toBe(true);
  });
});

describe('CreatePayoutSchema — la cifra que se vio', () => {
  it('expectedTotalCents opcional: céntimos enteros y positivos', () => {
    expect(CreatePayoutSchema.safeParse({}).success).toBe(true);
    expect(CreatePayoutSchema.safeParse({ expectedTotalCents: 12_500 }).success).toBe(true);
    for (const expectedTotalCents of [0, -100, 12.5, '12500']) {
      expect(CreatePayoutSchema.safeParse({ expectedTotalCents }).success).toBe(false);
    }
  });
});

describe('CreatePayoutBatchSchema — «Pagar» a varias a la vez (POST /admin/payout-batches)', () => {
  const id = (n: number) => `a1c3e5f7-2b4d-4e6f-8a0b-${String(n).padStart(12, '0')}`;
  const item = (n: number, expectedTotalCents = 9_000) => ({ operatorId: id(n), expectedTotalCents });

  it('de 1 a 50 personas, cada una con la cifra que se vio; el código 2FA, opcional', () => {
    expect(CreatePayoutBatchSchema.parse({ items: [item(1)] })).toEqual({ items: [item(1)] });
    expect(CreatePayoutBatchSchema.safeParse({ items: [item(1), item(2, 1)], totpCode: '123456' }).success).toBe(true);
    expect(PAYOUT_BATCH_MAX_ITEMS).toBe(50);
    expect(CreatePayoutBatchSchema.safeParse({ items: Array.from({ length: 50 }, (_, i) => item(i)) }).success).toBe(true);
    expect(CreatePayoutBatchSchema.safeParse({ items: Array.from({ length: 51 }, (_, i) => item(i)) }).success).toBe(false);
    expect(CreatePayoutBatchSchema.safeParse({ items: [] }).success).toBe(false);
    expect(CreatePayoutBatchSchema.safeParse({}).success).toBe(false);
    expect(CreatePayoutBatchSchema.safeParse({ items: [item(1)], totpCode: '12345' }).success).toBe(false);
  });

  it('sin repetidos (tampoco con otras mayúsculas) y con ids y cifras de verdad', () => {
    expect(CreatePayoutBatchSchema.safeParse({ items: [item(1), item(1, 500)] }).success).toBe(false);
    expect(
      CreatePayoutBatchSchema.safeParse({ items: [item(1), { operatorId: id(1).toUpperCase(), expectedTotalCents: 9_000 }] }).success,
    ).toBe(false);
    // El id sale en minúsculas: con él se arma la clave de cada pago.
    expect(CreatePayoutBatchSchema.parse({ items: [{ operatorId: id(7).toUpperCase(), expectedTotalCents: 1 }] }).items[0]!.operatorId).toBe(id(7));
    expect(CreatePayoutBatchSchema.safeParse({ items: [{ operatorId: 'lucia', expectedTotalCents: 9_000 }] }).success).toBe(false);
    for (const expectedTotalCents of [0, -100, 12.5, '12500', undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(CreatePayoutBatchSchema.safeParse({ items: [{ operatorId: id(1), expectedTotalCents }] }).success).toBe(false);
    }
  });

  it('el cuerpo no elige importe, método, cuenta ni notas: cualquier campo de más → no vale', () => {
    for (const extra of [{ amountCents: 1 }, { externalRail: 'MANUAL_CASH' }, { payoutAddress: 'ES91 2100 0418 4502 0005 1332' }, { notes: 'x' }, { externalTxId: 'abcd1234' }]) {
      expect(CreatePayoutBatchSchema.safeParse({ items: [{ ...item(1), ...extra }] }).success).toBe(false);
      expect(CreatePayoutBatchSchema.safeParse({ items: [item(1)], ...extra }).success).toBe(false);
    }
  });

  it('la respuesta: PAID / FAILED / SKIPPED por persona y los códigos de siempre', () => {
    expect(
      PayoutBatchResultSchema.safeParse({
        results: [
          { operatorId: id(1), status: 'PAID', payoutId: id(9), totalCents: 9_000 },
          { operatorId: id(2), status: 'FAILED', code: 'PAYOUT_CHANGED', totalCents: 8_000 },
          { operatorId: id(3), status: 'FAILED', code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: '2026-11-28T10:00:00.000Z' },
          { operatorId: id(4), status: 'SKIPPED', code: 'SKIPPED' },
        ],
        paidCount: 1,
        paidCents: 9_000,
      }).success,
    ).toBe(true);
    expect([...PAYOUT_BATCH_PROBLEM_CODES].sort()).toEqual(
      ['APPROVAL_ALREADY_PENDING', 'CASH', 'NOTHING_TO_PAY', 'NOT_FOUND', 'NO_ACCOUNT', 'OTHER', 'PAYOUT_ACCOUNT_TOO_NEW', 'PAYOUT_CHANGED', 'PAYOUT_HOLDER_UNCONFIRMED', 'SKIPPED', 'UNKNOWN'],
    );
  });
});
