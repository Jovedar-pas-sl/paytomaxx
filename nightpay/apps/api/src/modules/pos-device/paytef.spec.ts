import { describe, it, expect } from 'vitest';
import {
  POS_REFERENCE_LENGTH,
  cardBrandOf,
  formatPairingCode,
  last4Of,
  newPairingCode,
  normalizePairingCode,
  operationNumberOf,
  payMethodCodeOf,
  posReference,
  shiftAmountCents,
} from './paytef';

describe('datáfono PAX: resultado de Paytef', () => {
  const approved = {
    approved: true,
    authorisationCode: '047215',
    paytefOperationNumber: 99812,
    requestedAmount: 10_000,
    cardInformation: { hiddenCardNumber: '************1111', cardTypeCode: 'vi', isContactless: true },
  };

  it('referencia corta y estable para el datáfono', () => {
    const ref = posReference('7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b');
    expect(ref).toBe('NP7F1C2A9E3B4D4E5F8A');
    expect(ref).toHaveLength(POS_REFERENCE_LENGTH);
  });

  it('número de operación como texto, últimos 4 y marca como en Redsys', () => {
    expect(operationNumberOf(approved)).toBe('99812');
    expect(last4Of(approved)).toBe('1111');
    expect(cardBrandOf(approved)).toBe('1');
    expect(cardBrandOf({ approved: true, cardInformation: { cardTypeCode: 'ZZ' } })).toBeNull();
  });

  it('cómo se pagó: móvil, sin contacto, chip', () => {
    expect(payMethodCodeOf({ approved: true, cardInformation: { isMobile: true, isContactless: true } })).toBe(
      'PAX_MOBILE',
    );
    expect(payMethodCodeOf(approved)).toBe('PAX_CONTACTLESS');
    expect(payMethodCodeOf({ approved: true, cardInformation: { dataEntryLetter: 'chip' } })).toBe('PAX_CHIP');
    expect(payMethodCodeOf({ approved: true })).toBe('PAX');
  });

  it('sin número de operación → null', () => {
    expect(operationNumberOf({ approved: false })).toBeNull();
    expect(last4Of({ approved: true })).toBeNull();
  });
});

describe('vinculación del datáfono', () => {
  it('códigos de 8 caracteres sin letras que se confunden', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    }
  });

  it('se teclea como se quiera y se lee en dos bloques', () => {
    expect(normalizePairingCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(formatPairingCode('ABCD2345')).toBe('ABCD-2345');
  });
});

describe('cierre de jornada del datáfono', () => {
  it('importes en céntimos; texto con decimales son euros', () => {
    expect(shiftAmountCents(10_500)).toBe(10_500);
    expect(shiftAmountCents('-500')).toBe(-500);
    expect(shiftAmountCents('105,00')).toBe(10_500);
    expect(shiftAmountCents('abc')).toBeNull();
    expect(shiftAmountCents(undefined)).toBeNull();
  });
});
