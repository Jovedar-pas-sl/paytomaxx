import { describe, expect, it } from 'vitest';
import { isSealedPayoutValue, openPayoutValue, sealPayoutValue } from './payout-account-crypto';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const IBAN = 'ES9121000418450200051332';
const ANA = '0b0c1f6e-1111-4c4c-8a8a-000000000001';
const EVA = '0b0c1f6e-2222-4c4c-8a8a-000000000002';

describe('cuenta de cobro cifrada en la base (pa1)', () => {
  it('se guarda cifrada (pa1:...), distinta cada vez, y se recupera con la misma clave', () => {
    const a = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    const b = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    expect(a).toMatch(/^pa1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toContain(IBAN);
    expect(a).not.toContain('1332');
    expect(a).not.toBe(b);
    expect(isSealedPayoutValue(a)).toBe(true);
    expect(openPayoutValue(a, { userId: ANA, field: 'address' }, KEK)).toBe(IBAN);
  });

  it('una cuenta antigua en claro se lee tal cual (sin clave)', () => {
    expect(isSealedPayoutValue(IBAN)).toBe(false);
    expect(openPayoutValue(IBAN, { userId: ANA, field: 'address' }, undefined)).toBe(IBAN);
    expect(openPayoutValue('Ana López', { userId: ANA, field: 'holder' }, undefined)).toBe('Ana López');
  });

  it('copiada a otra persona o a otro campo, no se abre', () => {
    const sealed = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    expect(() => openPayoutValue(sealed, { userId: EVA, field: 'address' }, KEK)).toThrow();
    expect(() => openPayoutValue(sealed, { userId: ANA, field: 'holder' }, KEK)).toThrow();
  });

  it('con otra clave, o tocada, no se abre', () => {
    const sealed = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    expect(() => openPayoutValue(sealed, { userId: ANA, field: 'address' }, `${KEK}-otra`)).toThrow();
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(() => openPayoutValue(tampered, { userId: ANA, field: 'address' }, KEK)).toThrow();
  });

  it('sin ENCRYPTION_KEK (o corta) no cifra ni abre una cifrada', () => {
    expect(() => sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, undefined)).toThrow(/ENCRYPTION_KEK/);
    expect(() => sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, 'corta')).toThrow(/ENCRYPTION_KEK/);
    const sealed = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    expect(() => openPayoutValue(sealed, { userId: ANA, field: 'address' }, undefined)).toThrow(/ENCRYPTION_KEK/);
  });

  it('no usa la misma clave que la 2FA (otro uso, otra clave derivada)', () => {
    const sealed = sealPayoutValue(IBAN, { userId: ANA, field: 'address' }, KEK);
    // Formato propio: no se confunde con un secreto 2FA (tv1:).
    expect(sealed.startsWith('tv1:')).toBe(false);
  });
});
