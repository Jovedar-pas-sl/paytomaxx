import { describe, it, expect } from 'vitest';
import {
  cleanPartnerText,
  codePointLength,
  luhnRun,
  partnerTextPersonalData,
  partnerTextProblem,
  type WalletLoadRequestBody,
} from '@nightpay/contracts';
import { PartnerHttpException } from './http/partner-problem';
import { assertLoadTexts, voidReasonOf } from './wallet/partner-load-rules';

/**
 * Los textos de un socio (`description` de una carga y `reason` de una
 * anulación): §9.1 del diseño y el esquema `Description` del contrato.
 * Primero la forma (description_invalid), luego limpio y en puntos de código
 * la longitud (validation_failed), luego lo que parece un dato personal.
 */

const load = (description: string, over: Partial<WalletLoadRequestBody> = {}): WalletLoadRequestBody => ({
  qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001',
  amount: 2000,
  description,
  funding: 'cash',
  ...over,
});

function codeOf(fn: () => unknown): { code: string; param?: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof PartnerHttpException)) throw err;
    return { code: err.code, ...(err.extra.param ? { param: err.extra.param } : {}) };
  }
}

describe('textos de un socio: la forma (description_invalid)', () => {
  it.each([
    ['un salto de línea', 'Recarga\ncajero'],
    ['un tabulador', 'Recarga\tcajero'],
    ['un carácter de ancho cero (U+200B)', 'Recarga​cajero'],
    ['un cambio de dirección (U+202E)', 'Recarga ‮cajero'],
    ['un aislamiento bidi (U+2066)', 'Recarga ⁦cajero'],
    ['la marca de orden de bytes (U+FEFF)', '﻿Recarga'],
    ['un separador de línea (U+2028)', 'Recarga cajero'],
    ['un separador de párrafo (U+2029)', 'Recarga cajero'],
    ['<', 'Recarga <b>'],
    ['>', 'Recarga >'],
    ['un enlace', 'https://cajeros.example'],
    ['un enlace sin esquema', 'Mira www.cajeros'],
    ['un dominio', 'Recarga en cajeros.com'],
    ['un dominio en mayúsculas', 'Recarga en CAJEROS.ES'],
  ])('%s', (_what, text) => {
    expect(partnerTextProblem(text)).not.toBeNull();
    expect(codeOf(() => assertLoadTexts(load(text)))).toEqual({ code: 'description_invalid' });
  });

  it('textos normales: letras, acentos, ñ, cifras cortas, «·» y un emoji', () => {
    for (const text of ['Recarga en cajero 0042', 'Cajero Peñón · planta 2', 'Recarga 20 € 🎉', 'ATM-0042 / puerta']) {
      expect(partnerTextProblem(text), text).toBeNull();
      expect(codeOf(() => assertLoadTexts(load(text))), text).toBeNull();
    }
  });
});

describe('textos de un socio: la longitud, limpia y en puntos de código', () => {
  it('limpia: NFC, sin espacios alrededor y los de dentro juntados', () => {
    expect(cleanPartnerText('  Recarga   en  cajero ')).toBe('Recarga en cajero');
    expect(cleanPartnerText('Café')).toBe('Café');
    expect(assertLoadTexts(load('  Recarga   en  cajero 0042 '))).toBe('Recarga en cajero 0042');
  });

  it('60 puntos de código con un emoji valen; 61, validation_failed (`description`)', () => {
    const sixty = `${'a'.repeat(59)}🎉`;
    expect(sixty.length).toBe(61); // UTF-16: el emoji cuenta dos
    expect(codePointLength(sixty)).toBe(60);
    expect(codeOf(() => assertLoadTexts(load(sixty)))).toBeNull();
    const sixtyOne = `${'a'.repeat(60)}🎉`;
    expect(codePointLength(sixtyOne)).toBe(61);
    expect(codeOf(() => assertLoadTexts(load(sixtyOne)))).toEqual({ code: 'validation_failed', param: 'description' });
  });

  it('vacía o solo espacios: validation_failed (`description`)', () => {
    expect(codeOf(() => assertLoadTexts(load('')))).toEqual({ code: 'validation_failed', param: 'description' });
    expect(codeOf(() => assertLoadTexts(load('    ')))).toEqual({ code: 'validation_failed', param: 'description' });
  });

  it('`reason`: de 1 a 140, con las mismas reglas que description, y siempre validation_failed (`reason`)', () => {
    expect(voidReasonOf(undefined)).toBeNull();
    expect(voidReasonOf('  Billetes   devueltos al cliente ')).toBe('Billetes devueltos al cliente');
    expect(voidReasonOf(`${'a'.repeat(139)}🎉`)).toHaveLength(141);
    for (const bad of ['', '   ', 'a'.repeat(141), 'mira cajeros.com', 'ana@correo', 'Llamar al 612 345 678', 'Línea\nnueva']) {
      expect(codeOf(() => voidReasonOf(bad)), bad).toEqual({ code: 'validation_failed', param: 'reason' });
    }
  });
});

describe('textos de un socio: lo que parece un dato personal (description_personal_data)', () => {
  it.each([
    ['un correo', 'Para ana@correo'],
    ['un correo sin dominio con punto', 'cliente@cajero'],
    ['9 cifras seguidas', 'Ticket 123456789'],
    ['un teléfono con espacios', 'Llamar al 612 345 678'],
    ['un teléfono con puntos y guiones', 'Tel. 612.345-678'],
    ['un teléfono con «·» y «/»', 'Tel 612·345/678'],
    ['una tarjeta con espacios', 'Tarjeta 4111 1111 1111 1111'],
  ])('%s', (_what, text) => {
    expect(partnerTextProblem(text)).toBeNull();
    expect(partnerTextPersonalData(text)).toBe(true);
    expect(codeOf(() => assertLoadTexts(load(text)))).toEqual({ code: 'description_personal_data' });
  });

  it('8 cifras, o cifras que no se juntan, no', () => {
    for (const text of ['Cajero 12345678', 'Cajero 0042 noche 20261205', 'Planta 2, cajero 42']) {
      expect(partnerTextPersonalData(text), text).toBe(false);
    }
  });

  it('Luhn: 13 a 19 cifras seguidas que pasan la prueba', () => {
    expect(luhnRun('4111111111111111')).toBe(true); // 16, pasa
    expect(luhnRun('4111111111111112')).toBe(false); // 16, no pasa
    expect(luhnRun('4222222222222')).toBe(true); // 13, pasa
    expect(luhnRun('422222222222')).toBe(false); // 12: demasiado corta
    expect(luhnRun('ATM-4111111111111111-K7')).toBe(true);
    expect(luhnRun('ATM0042-20261205-000731-K7QM')).toBe(false);
  });

  it('`reference` con una tarjeta: validation_failed (`reference`); sin tarjeta, vale', () => {
    expect(codeOf(() => assertLoadTexts(load('Recarga', { reference: 'ATM-4111111111111111' })))).toEqual({
      code: 'validation_failed',
      param: 'reference',
    });
    expect(codeOf(() => assertLoadTexts(load('Recarga', { reference: 'ATM0042-20261205-000731-K7QM' })))).toBeNull();
  });

  it('en el orden del contrato: la forma antes que la longitud y los datos; la forma de pago la última', () => {
    expect(codeOf(() => assertLoadTexts(load(`www.${'1'.repeat(70)}`)))).toEqual({ code: 'description_invalid' });
    expect(codeOf(() => assertLoadTexts(load('1'.repeat(61))))).toEqual({ code: 'validation_failed', param: 'description' });
    expect(codeOf(() => assertLoadTexts(load('Recarga', { funding: 'card' })))).toEqual({ code: 'funding_not_allowed' });
    expect(codeOf(() => assertLoadTexts(load('Tel 612345678', { funding: 'card' })))).toEqual({ code: 'description_personal_data' });
  });
});
