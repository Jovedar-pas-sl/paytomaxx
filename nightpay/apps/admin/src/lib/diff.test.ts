import { describe, expect, it } from 'vitest';
import { changedFields, sameValue } from './diff';

describe('changedFields', () => {
  const initial = {
    phone: '+34 600',
    hasNie: false,
    walletProvider: null as string | null,
    notes: '',
  };

  it('solo lo que cambió (lo demás no se manda y no pisa lo guardado por otros)', () => {
    expect(changedFields(initial, { ...initial, hasNie: true })).toEqual({ hasNie: true });
  });

  it('sin cambios → vacío', () => {
    expect(changedFields(initial, { ...initial })).toEqual({});
  });

  it('pasar de valor a null también es un cambio', () => {
    expect(changedFields(initial, { ...initial, phone: null as unknown as string })).toEqual({ phone: null });
  });

  it('objetos comparados por valor, sin importar el orden de las claves', () => {
    const a = { meta: { bankName: 'TBC', country: 'Georgia' } };
    expect(changedFields(a, { meta: { country: 'Georgia', bankName: 'TBC' } })).toEqual({});
    expect(changedFields(a, { meta: { country: 'Georgia', bankName: 'BoG' } })).toEqual({
      meta: { country: 'Georgia', bankName: 'BoG' },
    });
  });
});

describe('sameValue', () => {
  it('null y objeto vacío no son lo mismo', () => {
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(true);
  });
});
