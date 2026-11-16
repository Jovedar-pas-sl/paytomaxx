import { describe, expect, it } from 'vitest';
import { pinTipButtons, pinTipCents, pinTipInitial, pinTipSetup, withScreenTip } from './pin-tip';

// B1: la propina la elige el cliente en la pantalla del PIN (en el móvil del
// personal), sin nada marcado; con la ficha sin PIN no hay propina.

const methods = { tipsOn: true, flatCents: [200, 500], percents: [10, 15] };

describe('la propina en la pantalla del PIN', () => {
  it('con las propinas encendidas (local y puesto): las sugeridas para el importe, como en la página de pago', () => {
    expect(pinTipSetup({ totalCents: 3300, ...methods })).toEqual({
      baseCents: 3300,
      previousCents: 0,
      maxCents: 3300,
      presets: [
        { cents: 200, percent: null },
        { cents: 500, percent: null },
      ],
    });
    // Por encima de 40 €: 10 % y 15 % en euros enteros.
    expect(pinTipSetup({ totalCents: 6000, ...methods })?.presets).toEqual([
      { cents: 600, percent: 10 },
      { cents: 900, percent: 15 },
    ]);
  });

  it('sin propinas (en el local o en el puesto): nada que elegir', () => {
    expect(pinTipSetup({ totalCents: 3300, ...methods, tipsOn: false })).toBeNull();
  });

  it('un cobro de antes con la propina del personal: lo vendido aparte y esa propina, marcada y se puede quitar', () => {
    const setup = pinTipSetup({ totalCents: 3800, tipCents: 500, ...methods })!;
    expect(setup).toMatchObject({ baseCents: 3300, previousCents: 500 });
    expect(pinTipInitial(setup)).toEqual({ kind: 'button', cents: 500 });
    expect(pinTipButtons({ ...setup, previousCents: 700 })).toEqual([200, 500, 700]);
  });

  it('sin nada marcado al abrir; sin elegir, «Sin propina» (0)', () => {
    const setup = pinTipSetup({ totalCents: 3300, ...methods })!;
    expect(pinTipInitial(setup)).toEqual({ kind: 'none' });
    expect(pinTipCents({ kind: 'none' }, setup)).toEqual({ cents: 0, error: null });
    expect(pinTipCents({ kind: 'button', cents: 500 }, setup)).toEqual({ cents: 500, error: null });
  });

  it('«Otra»: euros enteros hasta el máximo; vacía o de más, su error (y no se paga)', () => {
    const setup = pinTipSetup({ totalCents: 3300, ...methods })!;
    expect(pinTipCents({ kind: 'other', text: '7' }, setup)).toEqual({ cents: 700, error: null });
    expect(pinTipCents({ kind: 'other', text: '' }, setup)).toEqual({ cents: 0, error: 'empty' });
    expect(pinTipCents({ kind: 'other', text: '0' }, setup)).toEqual({ cents: 0, error: 'empty' });
    expect(pinTipCents({ kind: 'other', text: '34' }, setup)).toEqual({ cents: 0, error: 'max' });
    expect(pinTipCents({ kind: 'other', text: '3a3' }, setup)).toEqual({ cents: 3300, error: null });
  });
});

describe('la propina elegida en la pantalla de la barra, en el PIN del móvil', () => {
  const setup = pinTipSetup({ totalCents: 3300, tipsOn: true, flatCents: [200, 500], percents: [10, 15] });

  it('sale marcada (y se puede quitar); el total del PIN es lo vendido + ella', () => {
    const shown = withScreenTip(setup, 500);
    expect(shown).toMatchObject({ baseCents: 3300, previousCents: 500 });
    expect(pinTipInitial(shown!)).toEqual({ kind: 'button', cents: 500 });
  });

  it('sin elegir, sin propinas, o por encima del tope: lo de siempre (nada marcado)', () => {
    expect(withScreenTip(setup, 0)).toBe(setup);
    expect(withScreenTip(null, 500)).toBeNull();
    expect(withScreenTip(setup, 999_00)).toBe(setup);
    expect(pinTipInitial(withScreenTip(setup, 0)!)).toEqual({ kind: 'none' });
  });
});
