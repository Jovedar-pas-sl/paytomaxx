import { describe, expect, it } from 'vitest';
import { CARD_IC, CARD_MARKS, GPAY_MARK, LOCK_IC, PAY_MARKS_CSS, trustLine } from './pay-marks';
import { PAY_TEXT } from './pay-i18n';

/**
 * Las marcas de las páginas de pago: dentro de la página (la CSP del API no
 * deja cargar nada de fuera), sin botón de Apple hecho a mano y con nombre
 * para el lector de pantalla donde dicen algo.
 */

const ALL = { CARD_IC, CARD_MARKS, GPAY_MARK, LOCK_IC, PAY_MARKS_CSS };

describe('marcas de pago (pay-marks)', () => {
  it.each(Object.entries(ALL))('%s: nada de fuera (ni enlaces ni imágenes) y sin barras invertidas', (_name, markup) => {
    expect(markup).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(markup).not.toMatch(/<image|<img|href=|url\(/);
    expect(markup).not.toContain('\\');
  });

  it('Google Pay: la «G» de cuatro colores y «Pay» en gris, decorativa (el nombre lo lleva el botón)', () => {
    for (const color of ['#ea4335', '#4285f4', '#fbbc05', '#34a853', '#3c4043']) expect(GPAY_MARK).toContain(`fill="${color}"`);
    expect(GPAY_MARK).toContain('aria-hidden="true"');
  });

  it('Visa y Mastercard en su chapa blanca, con su nombre para el lector de pantalla', () => {
    expect(CARD_MARKS).toContain('role="img" aria-label="Visa, Mastercard"');
    expect(CARD_MARKS.match(/<rect width="38" height="24" rx="4" fill="#fff"\/>/g)).toHaveLength(2);
    expect(CARD_MARKS).toContain('fill="#1a1f71"');
    for (const color of ['#eb001b', '#f79e1b', '#ff5f00']) expect(CARD_MARKS).toContain(`fill="${color}"`);
  });

  it('los iconos de los botones son de trazo (.ic: toman el color del texto del botón) y decorativos', () => {
    for (const icon of [LOCK_IC, CARD_IC]) {
      expect(icon).toContain('class="ic"');
      expect(icon).toContain('aria-hidden="true"');
    }
  });

  it('Apple Pay no está aquí: su botón lo pinta Safari (nunca uno hecho a mano)', () => {
    expect(Object.values(ALL).join('')).not.toMatch(/apple/i);
  });

  it('antes de pagar, dónde se escribe la tarjeta (idea 63): el candado, la frase a 14 px y, debajo, las marcas', () => {
    const es = trustLine(PAY_TEXT.es);
    expect(es.startsWith(`<p class="trust">${LOCK_IC}La tarjeta la escribes en la página segura del banco, no en OxioPay.${CARD_MARKS}`)).toBe(true);
    expect(trustLine(PAY_TEXT.es, 'foot')).toContain('<p class="trust foot">');
    expect(trustLine(PAY_TEXT.en)).toContain('You enter your card on the bank’s secure page, not on OxioPay.');
    expect(trustLine(PAY_TEXT.fr)).toContain('Vous saisissez votre carte sur la page sécurisée de la banque, pas sur OxioPay.');
    expect(trustLine(PAY_TEXT.pt)).toContain('O cartão é introduzido na página segura do banco, não em OxioPay.');
    expect(PAY_MARKS_CSS).toMatch(/\.trust\{[^}]*font-size:\.875rem;[^}]*color:var\(--mute\)/);
    // Las marcas, en su propia línea debajo de la frase.
    expect(PAY_MARKS_CSS).toMatch(/\.trust \.marks\{display:flex;justify-content:center;[^}]*margin-top:/);
  });
});
