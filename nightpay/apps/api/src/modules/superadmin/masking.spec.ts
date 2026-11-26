import { describe, it, expect } from 'vitest';
import { maskEmail, maskIban, maskPayoutAddress, maskWalletAddress } from '@nightpay/contracts';
import { changedFields, maskSensitive } from './masking';

describe('máscaras de cuentas (contracts)', () => {
  it('IBAN → "ES12 •••• •••• 1234" (con o sin espacios)', () => {
    expect(maskIban('ES91 2100 0418 4502 0005 1332')).toBe('ES91 •••• •••• 1332');
    expect(maskIban('es9121000418450200051332')).toBe('ES91 •••• •••• 1332');
    expect(maskIban(null)).toBeNull();
    expect(maskIban('ES12')).toBe('••••');
  });

  it('cripto → "T…9f2a"; EVM conserva el 0x', () => {
    expect(maskWalletAddress('TXYZxQwUVqHbvHvgrkqz6T6oyhqcKp9f2a')).toBe('T…9f2a');
    expect(maskWalletAddress('0x55d398326f99059ff775485246999027b3197955')).toBe('0x…7955');
    expect(maskWalletAddress('abc')).toBe('••••');
  });

  it('según el método: IBAN, cripto, email y el resto "•••1234"', () => {
    expect(maskPayoutAddress('SEPA_IBAN', 'ES9121000418450200051332')).toBe('ES91 •••• •••• 1332');
    expect(maskPayoutAddress('USDC_SOL', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe('7…FLtV');
    expect(maskPayoutAddress('PAYONEER_EMAIL', 'ana.lopez@gmail.com')).toBe('a•••@gmail.com');
    expect(maskPayoutAddress('NEQUI_PHONE', '+573001234567')).toBe('•••4567');
    expect(maskPayoutAddress('SEPA_IBAN', null)).toBeNull();
    expect(maskEmail('sin-arroba')).toBe('••••');
  });
});

describe('maskSensitive — lo que va al registro', () => {
  it('contraseñas, tokens, secretos 2FA y hashes → [oculto]; los booleanos se quedan', () => {
    const out = maskSensitive({
      password: 'Abc12345',
      inviteToken: 'eyJ…',
      totpSecret: 'tv1:…',
      passwordHash: '$2a$…',
      totpEnabled: true,
      nested: { refreshToken: 'x', ok: 1 },
    });
    expect(out).toEqual({
      password: '[oculto]',
      inviteToken: '[oculto]',
      totpSecret: '[oculto]',
      passwordHash: '[oculto]',
      totpEnabled: true,
      nested: { refreshToken: '[oculto]', ok: 1 },
    });
  });

  it('IBAN y direcciones de cobro, tapados según su método (también en antes/después)', () => {
    const out = maskSensitive({
      before: { settlementIban: 'ES9121000418450200051332', settlementHolder: 'Luna SL' },
      after: { payoutMethod: 'USDT_TRC20', payoutAddress: 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKp9f2a' },
      proposedPayout: { method: 'SEPA_IBAN', address: 'ES9121000418450200051332' },
    });
    expect(out).toEqual({
      before: { settlementIban: 'ES91 •••• •••• 1332', settlementHolder: 'Luna SL' },
      after: { payoutMethod: 'USDT_TRC20', payoutAddress: 'T…9f2a' },
      proposedPayout: { method: 'SEPA_IBAN', address: 'ES91 •••• •••• 1332' },
    });
  });

  it('no toca el original; fechas a ISO; null y escalares tal cual', () => {
    const original = { password: 'x', at: new Date('2026-10-16T00:00:00Z') };
    expect(maskSensitive(original)).toEqual({ password: '[oculto]', at: '2026-10-16T00:00:00.000Z' });
    expect(original.password).toBe('x');
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive(5)).toBe(5);
  });

  it('changedFields: solo lo que cambió, con su antes y después', () => {
    expect(changedFields({ a: 1, b: 'x', c: { k: 1 } }, { a: 1, b: 'y', c: { k: 2 } })).toEqual({
      before: { b: 'x', c: { k: 1 } },
      after: { b: 'y', c: { k: 2 } },
    });
  });
});

describe('maskSensitive — API de socios', () => {
  it('la clave sellada del enlace y cualquier valor oxp_ → [oculto]', () => {
    const key = `oxp_live_${'0'.repeat(48)}`;
    expect(maskSensitive({ keyClaimSealed: 'k1:abc', sealed: 'x', nota: `la clave ${key}`, keyHint: 'oxp_live_…0000', lista: [key] })).toEqual({
      keyClaimSealed: '[oculto]',
      sealed: '[oculto]',
      nota: '[oculto]',
      keyHint: 'oxp_live_…0000',
      lista: ['[oculto]'],
    });
  });
});
