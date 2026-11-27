import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pinTipButtons,
  pinTipCents,
  pinTipInitial,
  pinTipOptions,
  pinTipSetup,
  pinTipToSend,
  screenTipNotice,
  tipDestination,
  withScreenTip,
} from './pin-tip';

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

describe('cada botón de propina dice el total con ella (idea 66)', () => {
  const setup = pinTipSetup({ totalCents: 3300, ...methods })!;

  it('«Sin propina» y las sugeridas, cada una con lo vendido + ella', () => {
    expect(pinTipOptions(setup)).toEqual([
      { cents: 0, totalCents: 3300 },
      { cents: 200, totalCents: 3500 },
      { cents: 500, totalCents: 3800 },
    ]);
  });

  it('un cobro de antes con propina: la base es lo vendido (baseCents), no el importe con la propina de antes', () => {
    const before = pinTipSetup({ totalCents: 4000, tipCents: 700, ...methods })!;
    expect(pinTipOptions(before)).toEqual([
      { cents: 0, totalCents: 3300 },
      { cents: 200, totalCents: 3500 },
      { cents: 500, totalCents: 3800 },
      { cents: 700, totalCents: 4000 },
    ]);
  });

  it('la elegida en la pantalla de la barra, igual: lo vendido + ella', () => {
    expect(pinTipOptions(withScreenTip(setup, 300)!)).toContainEqual({ cents: 300, totalCents: 3600 });
  });
});

describe('a quién va la propina y el aviso de la pantalla, en los dos idiomas', () => {
  it('«La propina» delante, en español y en inglés', () => {
    expect(tipDestination(true)).toEqual({ es: 'La propina va entera para el personal', en: 'The whole tip goes to the staff' });
    expect(tipDestination(false)).toEqual({ es: 'La propina es para el local', en: 'The tip goes to the venue' });
  });

  it('la propina que eligió en la pantalla: cuánto, y que se puede cambiar o quitar', () => {
    expect(screenTipNotice(200)).toEqual({
      es: 'En la pantalla elegiste 2\u00a0€ de propina. Puedes cambiarla o quitarla.',
      en: 'You chose a €2 tip on the screen. You can change or remove it.',
    });
    expect(screenTipNotice(250).en).toBe('You chose a €2.50 tip on the screen. You can change or remove it.');
  });
});

describe('la propina que se manda con el PIN: lo cobrado, lo que ve el cliente', () => {
  it('sin propina en la pantalla del PIN (Sala sin propinas): 0, nunca null (no se cobra la guardada)', () => {
    expect(pinTipToSend(null, 0)).toBe(0);
    expect(pinTipToSend(null, 500)).toBe(0);
    expect(pinTipToSend(pinTipSetup({ totalCents: 3300, ...methods }), 500)).toBe(500);
    expect(pinTipToSend(pinTipSetup({ totalCents: 3300, ...methods }), 0)).toBe(0);
  });

  it('la pantalla del PIN manda esa propina (no null cuando no la ofrece)', () => {
    const src = readFileSync(new URL('../components/cobrar/PinScreen.tsx', import.meta.url), 'utf8');
    expect(src).toContain('onPin(value, pinTipToSend(tipSetup, tipCents))');
    expect(src).not.toMatch(/onPin\(value, [^)]*: null\)/);
  });
});
