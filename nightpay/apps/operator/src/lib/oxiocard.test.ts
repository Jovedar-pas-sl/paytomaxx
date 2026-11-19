import { describe, expect, it } from 'vitest';
import { oxiocardText } from './oxiocard';

describe('su OxioCard en «Ganancias»', () => {
  it('sin pedir: qué es y el botón para pedirla', () => {
    expect(oxiocardText({ status: 'NO_SOLICITADA', at: null })).toEqual({
      state: 'No solicitada',
      text: 'Una tarjeta a tu nombre para cobrar aunque no tengas cuenta de banco.',
      canRequest: true,
    });
  });

  it('pedida: desde cuándo; los demás estados, qué pasa ahora; nunca el botón otra vez', () => {
    const asked = oxiocardText({ status: 'SOLICITADA', at: '2026-11-19T22:30:00Z' });
    expect(asked).toMatchObject({ state: 'Solicitada', canRequest: false });
    expect(asked.text).toBe('La pediste el 19 de noviembre. Aquí verás cómo va.');
    expect(oxiocardText({ status: 'EN_VERIFICACION', at: null })).toMatchObject({ state: 'En verificación', canRequest: false });
    expect(oxiocardText({ status: 'APROBADA', at: null }).text).toMatch(/dueño te dirá cuándo/);
    expect(oxiocardText({ status: 'RECHAZADA', at: null })).toMatchObject({ canRequest: false });
  });
});
