import { describe, expect, it } from 'vitest';
import type { ReceptionDeskView } from '@nightpay/contracts';
import { AMOUNT_HELP, METHOD_HELP, RECEPTION_HELP_SCREENS, handOverOf, loadedHelp, tapHelp } from './reception-help';

const NEW = { kind: 'new' } as unknown as ReceptionDeskView;
const SALDO_FICHA = { kind: 'saldo', fichaNumber: 'F1', code: 'K7Q-4M2' } as unknown as ReceptionDeskView;
const SALDO_CODIGO = { kind: 'saldo', fichaNumber: null, code: 'K7Q-4M2' } as unknown as ReceptionDeskView;

describe('la ayuda de cada paso de Recepción', () => {
  it('una clave por paso (cerrar una no cierra las otras)', () => {
    const keys = Object.values(RECEPTION_HELP_SCREENS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['recepcion-nfc', 'recepcion-importe', 'recepcion-pago', 'recepcion-cargado']);
  });

  it('acerca el NFC, el importe y cómo paga: qué hacer, en una línea', () => {
    expect(tapHelp('entrada')).toBe('Pon la ficha del cliente detrás del móvil: la app sabe si es nueva o si ya tiene saldo.');
    expect(tapHelp('salida')).toBe('Pon su ficha detrás del móvil para ver lo que le queda.');
    expect(AMOUNT_HELP).toContain('«Otro»');
    // Los botones de «¿Cómo paga?» ya dicen qué pasa con el dinero: aquí no se repite.
    expect(METHOD_HELP).not.toMatch(/caja|QR/);
    for (const text of [tapHelp('entrada'), tapHelp('salida'), AMOUNT_HELP, METHOD_HELP]) {
      expect(text).not.toMatch(/[!¡]/);
      expect(text.length).toBeLessThanOrEqual(90);
    }
  });
});

describe('CARGADO: qué se hace con la ficha', () => {
  it('como handOverLine: dar la nueva, devolver la suya, apuntar el código o nada', () => {
    expect(handOverOf({ view: NEW, linked: true, byNumber: false })).toBe('give');
    expect(handOverOf({ view: NEW, linked: false, byNumber: false })).toBe('code');
    expect(handOverOf({ view: null, linked: false, byNumber: false })).toBe('code');
    expect(handOverOf({ view: SALDO_FICHA, linked: true, byNumber: false })).toBe('return');
    expect(handOverOf({ view: SALDO_CODIGO, linked: true, byNumber: false })).toBe('none');
    expect(handOverOf({ view: null, linked: true, byNumber: true })).toBe('return');
  });
});

describe('CARGADO: qué hacer ahora, en orden', () => {
  it('efectivo y ficha nueva: a la caja y dale la ficha', () => {
    expect(loadedHelp({ method: 'cash', handOver: 'give', pin: 'none' })).toBe('Mete el efectivo en la caja y dale la ficha.');
  });

  it('si pasa del tope sin PIN, que elija su PIN (lo último)', () => {
    expect(loadedHelp({ method: 'cash', handOver: 'give', pin: 'ask' })).toBe(
      'Mete el efectivo en la caja, dale la ficha y pásale el móvil para que elija su PIN.',
    );
  });

  it('el PIN, si lo quiere, como opción', () => {
    expect(loadedHelp({ method: 'cash', handOver: 'give', pin: 'offer' })).toBe('Mete el efectivo en la caja y dale la ficha. Si quiere, que elija su PIN.');
  });

  it('con tarjeta no hay efectivo; la suya se devuelve; sin NFC, su código', () => {
    expect(loadedHelp({ method: 'card', handOver: 'give', pin: 'none' })).toBe('Dale la ficha.');
    expect(loadedHelp({ method: 'cash', handOver: 'return', pin: 'none' })).toBe('Mete el efectivo en la caja y devuélvele su ficha.');
    expect(loadedHelp({ method: 'cash', handOver: 'code', pin: 'none' })).toBe('Mete el efectivo en la caja y que apunte su código.');
  });

  it('el PIN con el encargado ya lo dice el aviso: aquí no se repite', () => {
    expect(loadedHelp({ method: 'cash', handOver: 'return', pin: 'manager' })).toBe('Mete el efectivo en la caja y devuélvele su ficha.');
  });

  it('nada que hacer: lo dice', () => {
    expect(loadedHelp({ method: 'card', handOver: 'none', pin: 'none' })).toBe('Ya está cargado: no hay que hacer nada más.');
    expect(loadedHelp({ method: 'card', handOver: 'none', pin: 'offer' })).toBe('Si quiere, que elija su PIN.');
  });

  it('cabe en dos líneas de un móvil (≤ 90 letras) y sin exclamaciones', () => {
    for (const method of ['cash', 'card'] as const) {
      for (const handOver of ['give', 'return', 'code', 'none'] as const) {
        for (const pin of ['none', 'offer', 'ask', 'manager'] as const) {
          const text = loadedHelp({ method, handOver, pin });
          expect(text.length, text).toBeLessThanOrEqual(90);
          expect(text).not.toMatch(/[!¡]/);
        }
      }
    }
  });
});
