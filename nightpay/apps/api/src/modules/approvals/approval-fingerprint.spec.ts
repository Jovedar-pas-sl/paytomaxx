import { describe, expect, it } from 'vitest';
import { accountFingerprint, buildPayoutPayload } from './approval-payload';
import { sealPayoutValue } from '../operators/payout-account-crypto';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
process.env.ENCRYPTION_KEK ??= KEK;
const IBAN = 'ES9121000418450200051332';
const OP = '0b0c1f6e-1111-4c4c-8a8a-000000000001';
const seal = (v: string, userId = 'op-1') => sealPayoutValue(v, { userId, field: 'address' });

describe('«Por aprobar»: la cuenta de la chica es la de cuando se pidió', () => {
  it('cifrarla (el relleno o volver a guardarla igual) no cuenta como cambio', () => {
    const plain = accountFingerprint({ id: 'op-1', payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN });
    expect(accountFingerprint({ id: 'op-1', payoutMethod: 'SEPA_IBAN', payoutAddress: seal(IBAN) })).toBe(plain);
    expect(accountFingerprint({ id: 'op-1', payoutMethod: 'SEPA_IBAN', payoutAddress: seal(IBAN) })).toBe(plain);
  });

  it('otra cuenta u otro método, sí', () => {
    const plain = accountFingerprint({ id: 'op-1', payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN });
    expect(accountFingerprint({ id: 'op-1', payoutMethod: 'SEPA_IBAN', payoutAddress: seal('ES7921000813610123456789') })).not.toBe(plain);
    expect(accountFingerprint({ id: 'op-1', payoutMethod: 'WIRE_INTERNATIONAL', payoutAddress: IBAN })).not.toBe(plain);
  });

  it('lo que ve el dueño en la petición: la cuenta tapada (la cifrada, con lo tapado guardado; la antigua en claro, al vuelo)', () => {
    const rest = { method: 'SEPA_IBAN', earningIds: ['0b0c1f6e-2222-4c4c-8a8a-000000000002'], debtIds: [], holdDays: 0 };
    const person = { id: OP, displayName: 'Ana', email: 'ana@x.es', payoutMethod: 'SEPA_IBAN', payoutLabel: null };
    const sealed = buildPayoutPayload({
      operator: { ...person, payoutAddress: seal(IBAN, OP), payoutAddressMasked: 'ES91 •••• •••• 1332' },
      ...rest,
    });
    expect(sealed.accountMasked).toBe('ES91 •••• •••• 1332');
    const legacy = buildPayoutPayload({ operator: { ...person, payoutAddress: IBAN }, ...rest });
    expect(legacy.accountMasked).toBe('ES91 •••• •••• 1332');
    expect(JSON.stringify([sealed, legacy])).not.toContain(IBAN);
    expect(JSON.stringify(sealed)).not.toContain('pa1:');
  });
});

describe('«Por aprobar» con una cuenta que no se puede abrir (se cambió ENCRYPTION_KEK)', () => {
  const unreadable = sealPayoutValue(IBAN, { userId: OP, field: 'address' }, 'otra_clave_0123456789abcdef0123456789abcdef');

  it('pedir un pago no se rompe: la huella es la de lo guardado y la cuenta sale tapada sin abrirla', () => {
    const operator = { id: OP, displayName: 'Ana', email: 'ana@x.es', payoutMethod: 'SEPA_IBAN', payoutAddress: unreadable, payoutLabel: null };
    const print = accountFingerprint(operator);
    expect(print).toBe(accountFingerprint({ ...operator }));
    expect(print).not.toBe(accountFingerprint({ ...operator, payoutAddress: seal(IBAN, OP) }));
    const payload = buildPayoutPayload({
      operator: { ...operator, payoutAddressMasked: 'ES91 •••• •••• 1332' },
      method: 'MANUAL_CASH',
      earningIds: ['0b0c1f6e-2222-4c4c-8a8a-000000000002'],
      debtIds: [],
      holdDays: 0,
    });
    expect(payload.accountMasked).toBeNull();
    const sameRail = buildPayoutPayload({
      operator: { ...operator, payoutAddressMasked: 'ES91 •••• •••• 1332' },
      method: 'SEPA_IBAN',
      earningIds: ['0b0c1f6e-2222-4c4c-8a8a-000000000002'],
      debtIds: [],
      holdDays: 0,
    });
    expect(sameRail.accountMasked).toBe('ES91 •••• •••• 1332');
  });
});
