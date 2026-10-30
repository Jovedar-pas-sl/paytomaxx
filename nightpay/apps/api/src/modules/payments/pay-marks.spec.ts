import { describe, expect, it } from 'vitest';
import { CARD_IC, CARD_MARKS, GPAY_MARK, LOCK_IC, PAY_MARKS_CSS } from './pay-marks';

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
});
