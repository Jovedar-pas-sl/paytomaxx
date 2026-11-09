import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { WALLET_TEXT } from './wallet-text';
import { topUpFeeExplain } from './wallet-topup-view';

/**
 * Los textos de «Recargar» (/w) que explican la recarga: la línea de arriba,
 * qué pasa con lo que no gaste y el «¿Qué es?» de la comisión de la recarga.
 * Lo que vale para todos los textos del cliente (claves, huecos, marcas…) ya
 * lo prueba payments/i18n/i18n.spec.ts.
 */

const NEW_KEYS = ['topUpWhy', 'topUpLeftover', 'topUpLeftoverFee', 'topUpFeeExplain'] as const;

describe('textos de «Recargar» en la página del saldo', () => {
  it.each(PAY_LANGUAGES)('%s: lo que no gaste nombra «Me voy» como el botón de la página', (lang) => {
    const t = WALLET_TEXT[lang];
    // «Me voy: devolver mi saldo» → «Me voy» (en francés, con su espacio irrompible antes de «:»).
    const button = t.leaveRow.split(':')[0]?.trim() ?? '';
    expect(button.length).toBeGreaterThan(3);
    expect(t.topUpLeftover).toContain(button);
    expect(t.topUpLeftoverFee).toContain(button);
  });

  it.each(PAY_LANGUAGES)('%s: con comisión, lo mismo y además que la comisión no se devuelve', (lang) => {
    const t = WALLET_TEXT[lang];
    expect(t.topUpLeftoverFee.startsWith(t.topUpLeftover)).toBe(true);
    expect(t.topUpLeftoverFee.length).toBeGreaterThan(t.topUpLeftover.length + 20);
  });

  it('en castellano, lo que hace el código: no caduca, a la tarjeta con «Me voy» y la comisión no se devuelve', () => {
    const t = WALLET_TEXT.es;
    expect(t.topUpWhy).toBe('Elige cuánto y paga con Apple Pay, Google Pay o tarjeta, sin propina. Tu saldo sube al momento.');
    expect(t.topUpLeftover).toContain('no se pierde');
    expect(t.topUpLeftover).toContain('a tu tarjeta');
    // Se cargó con tarjeta: no sale en efectivo.
    expect(t.topUpLeftover).not.toContain('efectivo');
    expect(t.topUpLeftoverFee).toContain('La comisión del servicio no se devuelve.');
  });

  it.each(PAY_LANGUAGES)('%s: «¿Qué es?» de la recarga lleva el % dentro y no deja huecos', (lang) => {
    const text = topUpFeeExplain(lang, '12 %');
    expect(text).toContain('12 %');
    expect(text).not.toMatch(/\{[a-z]+\}/);
  });

  it('«¿Qué es?» de la recarga habla de la recarga, no del consumo', () => {
    expect(topUpFeeExplain('es', '12 %')).toBe('Es un 12 % de la recarga, para la plataforma de pago. No va a tu saldo y no es una propina.');
    expect(topUpFeeExplain('en', '12%')).toContain('on the top-up');
  });

  it.each(PAY_LANGUAGES)('%s: sin signos de exclamación, sin emojis y sin gritar', (lang) => {
    for (const key of NEW_KEYS) {
      const text = WALLET_TEXT[lang][key];
      expect(text, key).not.toMatch(/[!¡]|\p{Extended_Pictographic}/u);
      expect(text, key).not.toMatch(/\b[A-ZÁÉÍÓÚÑ]{4,}\b/);
    }
  });
});
