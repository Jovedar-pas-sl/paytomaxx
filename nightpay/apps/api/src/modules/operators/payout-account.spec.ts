import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { describe, expect, it } from 'vitest';
import {
  accountForAudit,
  maskedPayoutAccount,
  openPayoutAccount,
  planPayoutAccountChange,
  sealLegacyPayoutAccount,
  type StoredPayoutAccount,
} from './payout-account';
import { openPayoutValue, sealPayoutValue } from './payout-account-crypto';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const ID = '0b0c1f6e-1111-4c4c-8a8a-000000000001';
const IBAN = 'ES9121000418450200051332';
const IBAN2 = 'ES7921000813610123456789';
const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const NOW = new Date('2026-11-19T22:00:00.000Z');
const H48 = new Date('2026-11-21T22:00:00.000Z');

const empty: StoredPayoutAccount = { id: ID, payoutMethod: null, payoutAddress: null, payoutMetadata: null, payoutLabel: null };

/** Una cuenta SEPA ya guardada (cifrada), cambiada hace tiempo. */
function savedSepa(over: Partial<StoredPayoutAccount> = {}): StoredPayoutAccount {
  return {
    id: ID,
    payoutMethod: 'SEPA_IBAN',
    payoutAddress: sealPayoutValue(IBAN, { userId: ID, field: 'address' }, KEK),
    payoutMetadata: { accountHolder: sealPayoutValue('Ana López', { userId: ID, field: 'holder' }, KEK) },
    payoutLabel: 'Mi banco',
    payoutAddressMasked: 'ES91 •••• •••• 1332',
    payoutHolderMasked: 'A••• L•••',
    payoutAccountChangedAt: new Date('2026-10-01T10:00:00.000Z'),
    payoutHoldUntil: null,
    ...over,
  };
}

describe('abrir y tapar lo guardado', () => {
  it('cifrada: se abre con la clave; tapada, sale de las columnas tapadas', () => {
    const row = savedSepa();
    expect(openPayoutAccount(row, KEK)).toEqual({
      method: 'SEPA_IBAN',
      address: IBAN,
      metadata: { accountHolder: 'Ana López' },
      label: 'Mi banco',
    });
    expect(maskedPayoutAccount(row)).toEqual({
      method: 'SEPA_IBAN',
      addressMasked: 'ES91 •••• •••• 1332',
      holderMasked: 'A••• L•••',
      metadata: null,
      label: 'Mi banco',
    });
  });

  it('antigua en claro (antes del relleno): se lee igual y se tapa al vuelo, sin clave', () => {
    const legacy: StoredPayoutAccount = {
      id: ID,
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutAddress: 'GE29NB0000000101904917',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila Rodriguez' },
      payoutLabel: null,
    };
    expect(openPayoutAccount(legacy, undefined).address).toBe('GE29NB0000000101904917');
    expect(maskedPayoutAccount(legacy)).toEqual({
      method: 'WIRE_INTERNATIONAL',
      addressMasked: 'GE29 •••• •••• 4917',
      holderMasked: 'C••• R•••',
      metadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22' },
      label: null,
    });
  });

  it('en claro con lo tapado de otra cuenta (la cambió el API anterior mientras se publicaba): manda lo que hay en claro', () => {
    const stale: StoredPayoutAccount = {
      id: ID,
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: IBAN2,
      payoutMetadata: { accountHolder: 'Eva Ruiz' },
      payoutLabel: null,
      payoutAddressMasked: 'ES91 •••• •••• 1332',
      payoutHolderMasked: 'A••• L•••',
    };
    expect(maskedPayoutAccount(stale)).toMatchObject({ addressMasked: 'ES79 •••• •••• 6789', holderMasked: 'E••• R•••' });
  });

  it('cifrada sin lo tapado (no debería pasar): «••••», nunca lo cifrado', () => {
    const row = savedSepa({ payoutAddressMasked: null, payoutHolderMasked: null });
    expect(maskedPayoutAccount(row)).toMatchObject({ addressMasked: '••••', holderMasked: '••••' });
  });

  it('sin cuenta: todo null', () => {
    expect(maskedPayoutAccount(empty)).toEqual({ method: null, addressMasked: null, holderMasked: null, metadata: null, label: null });
  });

  it('para el registro: la cuenta y el titular tapados, nunca en claro', () => {
    const audit = accountForAudit(openPayoutAccount(savedSepa(), KEK));
    expect(audit).toEqual({
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: 'ES91 •••• •••• 1332',
      payoutHolder: 'A••• L•••',
      payoutLabel: 'Mi banco',
    });
    expect(JSON.stringify(audit)).not.toContain(IBAN);
    expect(JSON.stringify(audit)).not.toContain('López');
  });
});

describe('planPayoutAccountChange — guardar un cambio de cuenta', () => {
  it('la primera cuenta: cifrada, tapada aparte, con aviso y sin espera', () => {
    const plan = planPayoutAccountChange(
      empty,
      { method: 'SEPA_IBAN', address: 'es91 2100 0418 4502 0005 1332', metadata: { accountHolder: ' Ana López ' } },
      NOW,
      KEK,
    );
    expect(plan.first).toBe(true);
    expect(plan.accountChanged).toBe(true);
    expect(plan.holdUntil).toBeNull();
    const data = plan.data as Record<string, unknown>;
    expect(data.payoutMethod).toBe('SEPA_IBAN');
    expect(String(data.payoutAddress)).toMatch(/^pa1:/);
    expect(openPayoutValue(String(data.payoutAddress), { userId: ID, field: 'address' }, KEK)).toBe(IBAN);
    expect(data.payoutAddressMasked).toBe('ES91 •••• •••• 1332');
    const meta = data.payoutMetadata as { accountHolder: string };
    expect(openPayoutValue(meta.accountHolder, { userId: ID, field: 'holder' }, KEK)).toBe('Ana López');
    expect(data.payoutHolderMasked).toBe('A••• L•••');
    expect(data.payoutAccountChangedAt).toEqual(NOW);
    expect(data.payoutHoldUntil).toBeNull();
    expect(JSON.stringify(data)).not.toContain(IBAN);
    expect(JSON.stringify(data)).not.toContain('López');
  });

  it('cambiar una cuenta que ya había: 48 h de espera', () => {
    const plan = planPayoutAccountChange(
      savedSepa(),
      { method: 'SEPA_IBAN', address: IBAN2, metadata: { accountHolder: 'Ana López' } },
      NOW,
      KEK,
    );
    expect(plan.first).toBe(false);
    expect(plan.destinationChanged).toBe(true);
    expect(plan.holdUntil).toEqual(H48);
    expect((plan.data as Record<string, unknown>).payoutHoldUntil).toEqual(H48);
    expect(plan.before.address).toBe(IBAN);
    expect(plan.after.address).toBe(IBAN2);
  });

  it('pasar a efectivo: sin espera (y quita la que hubiera)', () => {
    const plan = planPayoutAccountChange(savedSepa({ payoutHoldUntil: H48 }), { method: 'MANUAL_CASH', address: null }, NOW, KEK);
    expect(plan.holdUntil).toBeNull();
    const data = plan.data as Record<string, unknown>;
    expect(data.payoutHoldUntil).toBeNull();
    expect(data.payoutAddress).toBeNull();
    expect(data.payoutAddressMasked).toBeNull();
    // El efectivo no lleva datos del banco: se quitan.
    expect(data.payoutMetadata).toBe(Prisma.DbNull);
    expect(data.payoutHolderMasked).toBeNull();
  });

  it('de efectivo a una cuenta: no es la primera, espera', () => {
    const cash: StoredPayoutAccount = { ...empty, payoutMethod: 'MANUAL_CASH' };
    const plan = planPayoutAccountChange(cash, { method: 'USDT_TRC20', address: TRON }, NOW, KEK);
    expect(plan.first).toBe(false);
    expect(plan.holdUntil).toEqual(H48);
  });

  it('quitada y vuelta a poner: tampoco es la primera (ya hubo un cambio)', () => {
    const removed: StoredPayoutAccount = { ...empty, payoutAccountChangedAt: new Date('2026-11-18T10:00:00.000Z') };
    const plan = planPayoutAccountChange(removed, { method: 'USDT_TRC20', address: TRON }, NOW, KEK);
    expect(plan.first).toBe(false);
    expect(plan.holdUntil).toEqual(H48);
  });

  it('solo el alias: no cambia la cuenta (ni aviso ni espera)', () => {
    const plan = planPayoutAccountChange(savedSepa(), { label: 'Banco nuevo' }, NOW, KEK);
    expect(plan.accountChanged).toBe(false);
    expect(plan.data).toEqual({ payoutLabel: 'Banco nuevo' });
  });

  it('la misma cuenta otra vez (con el formulario entero): no cuenta como cambio', () => {
    const plan = planPayoutAccountChange(
      savedSepa(),
      { method: 'SEPA_IBAN', address: 'ES91 2100 0418 4502 0005 1332', metadata: { accountHolder: 'Ana López' }, label: 'Mi banco' },
      NOW,
      KEK,
    );
    expect(plan.accountChanged).toBe(false);
    expect(plan.destinationChanged).toBe(false);
    expect((plan.data as Record<string, unknown>).payoutHoldUntil).toBeUndefined();
  });

  it('otro titular con la misma cuenta: aviso, pero sin espera (el dinero va al mismo sitio)', () => {
    const plan = planPayoutAccountChange(savedSepa(), { metadata: { accountHolder: 'Eva Ruiz' } }, NOW, KEK);
    expect(plan.accountChanged).toBe(true);
    expect(plan.destinationChanged).toBe(false);
    expect((plan.data as Record<string, unknown>).payoutHoldUntil).toBeUndefined();
    expect((plan.data as Record<string, unknown>).payoutHolderMasked).toBe('E••• R•••');
  });

  it('IBAN SEPA nuevo sin titular → 400', () => {
    expect(() => planPayoutAccountChange(empty, { method: 'SEPA_IBAN', address: IBAN }, NOW, KEK)).toThrow(BadRequestException);
    expect(() => planPayoutAccountChange(empty, { method: 'SEPA_IBAN', address: IBAN }, NOW, KEK)).toThrow(
      'Falta el titular de la cuenta',
    );
    // Cambiar la cuenta de una SEPA antigua sin titular también lo pide.
    const old: StoredPayoutAccount = { ...empty, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN };
    expect(() => planPayoutAccountChange(old, { address: IBAN2 }, NOW, KEK)).toThrow('Falta el titular de la cuenta');
  });

  it('cambiar solo el IBAN de una SEPA con titular: se queda el titular guardado', () => {
    const plan = planPayoutAccountChange(savedSepa(), { address: IBAN2 }, NOW, KEK);
    expect(plan.after.metadata).toEqual({ accountHolder: 'Ana López' });
    expect((plan.data as Record<string, unknown>).payoutMetadata).toBeUndefined();
    expect(plan.holdUntil).toEqual(H48);
  });

  it('una SEPA antigua sin titular sigue valiendo mientras no se cambie la cuenta', () => {
    const old: StoredPayoutAccount = { ...empty, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN };
    expect(planPayoutAccountChange(old, { label: 'x' }, NOW, KEK).data).toEqual({ payoutLabel: 'x' });
  });

  it('la cuenta tiene que ser del método (como antes)', () => {
    expect(() => planPayoutAccountChange(empty, { method: 'USDT_TRC20', address: IBAN }, NOW, KEK)).toThrow(BadRequestException);
  });
});

describe('sealLegacyPayoutAccount — el relleno: cifrar lo que estaba en claro', () => {
  const legacy: StoredPayoutAccount = {
    id: ID,
    payoutMethod: 'WIRE_INTERNATIONAL',
    payoutAddress: 'GE29NB0000000101904917',
    payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila Rodriguez' },
    payoutLabel: 'TBC',
  };

  it('cuenta y titular en claro: cifrados y tapados aparte; se abren igual que estaban', () => {
    const data = sealLegacyPayoutAccount(legacy, KEK)!;
    expect(Object.keys(data).sort()).toEqual(['payoutAddress', 'payoutAddressMasked', 'payoutHolderMasked', 'payoutMetadata']);
    expect(data.payoutAddressMasked).toBe('GE29 •••• •••• 4917');
    expect(data.payoutHolderMasked).toBe('C••• R•••');
    expect(JSON.stringify(data)).not.toContain('GE29NB0000000101904917');
    expect(JSON.stringify(data)).not.toContain('Rodriguez');
    // El banco y el SWIFT siguen como estaban.
    expect(data.payoutMetadata).toMatchObject({ bankName: 'TBC Bank', swiftBic: 'TBCBGE22' });
    const after = { ...legacy, ...data } as StoredPayoutAccount;
    expect(openPayoutAccount(after, KEK)).toEqual(openPayoutAccount(legacy, KEK));
  });

  it('no cambia ni el método, ni el alias, ni las fechas del cambio (no es un cambio de cuenta)', () => {
    const data = sealLegacyPayoutAccount(legacy, KEK)!;
    for (const k of ['payoutMethod', 'payoutLabel', 'payoutAccountChangedAt', 'payoutHoldUntil', 'payoutNoticeSeenAt']) {
      expect(data).not.toHaveProperty(k);
    }
  });

  it('se puede repetir: lo ya cifrado no se toca', () => {
    const once = { ...legacy, ...sealLegacyPayoutAccount(legacy, KEK)! } as StoredPayoutAccount;
    expect(sealLegacyPayoutAccount(once, KEK)).toBeNull();
    expect(sealLegacyPayoutAccount(savedSepa(), KEK)).toBeNull();
  });

  it('solo falta el titular (o solo la cuenta): se cifra lo que falta', () => {
    const holderOnly = savedSepa({ payoutMetadata: { accountHolder: 'Ana López' }, payoutHolderMasked: null });
    const data = sealLegacyPayoutAccount(holderOnly, KEK)!;
    expect(Object.keys(data).sort()).toEqual(['payoutHolderMasked', 'payoutMetadata']);
    expect(data.payoutHolderMasked).toBe('A••• L•••');
    const addressOnly: StoredPayoutAccount = { ...empty, payoutMethod: 'USDT_TRC20', payoutAddress: TRON };
    const sealed = sealLegacyPayoutAccount(addressOnly, KEK)!;
    expect(Object.keys(sealed).sort()).toEqual(['payoutAddress', 'payoutAddressMasked']);
    expect(sealed.payoutAddressMasked).toBe('T…uFiV');
  });

  it('sin cuenta (o en efectivo, o vacía): nada que hacer', () => {
    expect(sealLegacyPayoutAccount(empty, KEK)).toBeNull();
    expect(sealLegacyPayoutAccount({ ...empty, payoutMethod: 'MANUAL_CASH' }, KEK)).toBeNull();
    expect(sealLegacyPayoutAccount({ ...empty, payoutMethod: 'USDT_TRC20', payoutAddress: '  ' }, KEK)).toBeNull();
  });

  it('sin ENCRYPTION_KEK no cifra nada (lanza: quien rellena lo cuenta como fallo)', () => {
    expect(() => sealLegacyPayoutAccount(legacy, 'corta')).toThrow(/ENCRYPTION_KEK/);
  });
});

describe('la cuenta guardada no se puede abrir (se cambió ENCRYPTION_KEK): hay que poder ponerla otra vez', () => {
  const OTHER_KEK = `${KEK}-otra`;

  it('una cuenta nueva entera se guarda (con la clave de ahora), con espera y aviso; lo de antes no se sabe', () => {
    const plan = planPayoutAccountChange(
      savedSepa(),
      { method: 'SEPA_IBAN', address: IBAN2, metadata: { accountHolder: 'Ana López' } },
      NOW,
      OTHER_KEK,
    );
    expect(plan.before).toEqual({ method: 'SEPA_IBAN', address: null, metadata: null, label: 'Mi banco' });
    expect(plan.accountChanged).toBe(true);
    expect(plan.holdUntil).toEqual(H48);
    const data = plan.data as Record<string, unknown>;
    expect(openPayoutValue(String(data.payoutAddress), { userId: ID, field: 'address' }, OTHER_KEK)).toBe(IBAN2);
    const meta = data.payoutMetadata as { accountHolder: string };
    expect(openPayoutValue(meta.accountHolder, { userId: ID, field: 'holder' }, OTHER_KEK)).toBe('Ana López');
  });

  it('sin el titular no vale (el guardado tampoco se puede leer)', () => {
    expect(() => planPayoutAccountChange(savedSepa(), { address: IBAN2 }, NOW, OTHER_KEK)).toThrow('Falta el titular de la cuenta');
  });

  it('cambiar solo el alias no toca la cuenta que no se puede leer', () => {
    expect(planPayoutAccountChange(savedSepa(), { label: 'Otro' }, NOW, OTHER_KEK).data).toEqual({ payoutLabel: 'Otro' });
  });
});
