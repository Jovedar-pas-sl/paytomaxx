import { describe, it, expect } from 'vitest';
import { isSealedTokenization, openTokenizationData, sealTokenizationData } from './tokenization-seal';

const KEK = 'clave-del-servidor-para-las-pruebas-0123456789';
const data = {
  identifier: 'b2e3a1f09c4d4e5f8a7b6c5d4e3f2a1b0c9d8e7f',
  expiry: '2812',
  cardLast4: '4444',
  cardBrand: '1',
  cofTxnId: '2510150930123456',
  capturedAt: '2026-10-15T09:30:00.000Z',
};

describe('token de la tarjeta de Redsys cifrado (#60)', () => {
  it('el token y el id de la operación original no quedan en claro; lo demás sí', () => {
    const stored = sealTokenizationData(data, KEK);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(data.identifier);
    expect(text).not.toContain(data.cofTxnId);
    expect(stored).toMatchObject({ v: 1, cardLast4: '4444', cardBrand: '1', expiry: '2812' });
    expect(isSealedTokenization(stored)).toBe(true);
  });

  it('se abre con la misma clave', () => {
    expect(openTokenizationData(sealTokenizationData(data, KEK), KEK)).toEqual(data);
  });

  it('cada vez se cifra distinto (iv aleatorio)', () => {
    expect(sealTokenizationData(data, KEK).sealed).not.toBe(sealTokenizationData(data, KEK).sealed);
  });

  it('otra clave o un valor manipulado → error, nunca datos falsos', () => {
    const stored = sealTokenizationData(data, KEK);
    expect(() => openTokenizationData(stored, `${KEK}-otra`)).toThrow();
    const [iv, tag, ct] = String(stored.sealed).split('.');
    const flipped = `${iv}.${tag}.${ct!.slice(0, -2)}${ct!.endsWith('AA') ? 'AB' : 'AA'}`;
    expect(() => openTokenizationData({ ...stored, sealed: flipped }, KEK)).toThrow();
  });

  it('valores antiguos en claro se leen tal cual; sin datos → null', () => {
    expect(isSealedTokenization(data)).toBe(false);
    expect(openTokenizationData(data, KEK)).toEqual(data);
    expect(openTokenizationData(null, KEK)).toBeNull();
  });

  it('sin ENCRYPTION_KEK no se guarda en claro: error', () => {
    expect(() => sealTokenizationData(data, undefined)).toThrow(/ENCRYPTION_KEK/);
    expect(() => sealTokenizationData(data, 'corta')).toThrow(/ENCRYPTION_KEK/);
  });
});
