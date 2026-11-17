import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { WALLET_TEXT } from './wallet-text';
import { topUpCard, topUpFeeExplain } from './wallet-topup-view';
import type { TopUpOptions } from './wallet-topup.service';

/**
 * Los textos de «Recargar» (/w) que explican la recarga: la línea de arriba,
 * la regla del saldo antes de pagar y el «¿Qué es?» de la comisión de la
 * recarga. Lo que vale para todos los textos del cliente (claves, huecos,
 * marcas…) ya lo prueba payments/i18n/i18n.spec.ts.
 */

const NEW_KEYS = ['topUpWhy', 'keepRule', 'topUpFeeExplain'] as const;

describe('textos de «Recargar» en la página del saldo', () => {
  it('la regla del dueño (17-nov): el saldo no se devuelve, se queda para la próxima visita', () => {
    expect(WALLET_TEXT.es.keepRule).toBe('El saldo no se devuelve: se queda para la próxima visita.');
    expect(WALLET_TEXT.en.keepRule).toBe('Your balance is not refunded: it stays for your next visit.');
    expect(WALLET_TEXT.pt.keepRule).toBe('O saldo não é devolvido: fica para a sua próxima visita.');
    expect(WALLET_TEXT.fr.keepRule.replace(/ /g, ' ')).toBe('Le solde n’est pas remboursé : il reste pour votre prochaine visite.');
    for (const lang of PAY_LANGUAGES) {
      // Ni «Me voy», ni la tarjeta, ni si caduca o no: nada que el código no haga.
      expect(WALLET_TEXT[lang].keepRule).not.toMatch(/Me voy|leaving|Je pars|Vou embora|tarjeta|card|carte|cartão|caduc|expir/i);
    }
  });

  it.each(PAY_LANGUAGES)('%s: la regla va justo antes del botón de pagar la recarga (con y sin comisión)', (lang) => {
    for (const serviceFeeBps of [null, 1200]) {
      const options: TopUpOptions = { allowed: true, block: null, presetsCents: [2000, 5000], minCents: 1000, maxCents: 30000, serviceFeeBps, feesCents: null };
      const html = topUpCard(lang, options);
      const rule = html.indexOf(`<p class="small" id="topupRule">${WALLET_TEXT[lang].keepRule}</p>`);
      expect(rule).toBeGreaterThan(-1);
      expect(rule).toBeLessThan(html.indexOf('id="topupGo"'));
    }
  });

  it('en castellano, la línea de arriba sigue diciendo cómo se recarga', () => {
    expect(WALLET_TEXT.es.topUpWhy).toBe('Elige cuánto y paga con Apple Pay, Google Pay o tarjeta, sin propina. Tu saldo sube al momento.');
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
