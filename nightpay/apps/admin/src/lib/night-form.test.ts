import { describe, expect, it } from 'vitest';
import { DEFAULT_NIGHT_SETTINGS } from '@nightpay/contracts';
import { eurosText, nightChange, nightFormFrom, noPinSummary, parseQuickAmounts, quickAmountsText } from './night-form';

const current = DEFAULT_NIGHT_SETTINGS;

describe('Ajustes → Noche', () => {
  it('lo de fábrica se enseña tal cual se teclea y, sin tocar nada, no hay nada que mandar', () => {
    const form = nightFormFrom(current);
    expect(form).toEqual({
      noPinMaxEur: '20',
      noPinNightCapEur: '100',
      pinKeypad: 'fixed',
      quickAmountsEur: '20, 50, 100',
      receptionDefaultMethod: 'cash',
      feedbackVibration: true,
      feedbackSound: true,
    });
    expect(nightChange(form, current)).toEqual({ ok: true, change: {} });
  });

  it('solo se manda lo que cambia (el teclado desordenado, otros importes, la tarjeta por defecto, sin sonido)', () => {
    const form = {
      ...nightFormFrom(current),
      noPinMaxEur: '15',
      pinKeypad: 'shuffled' as const,
      quickAmountsEur: '100 50, 30',
      receptionDefaultMethod: 'card' as const,
      feedbackSound: false,
    };
    expect(nightChange(form, current)).toEqual({
      ok: true,
      change: {
        nfcNoPinMaxCents: 1_500,
        pinKeypad: 'shuffled',
        receptionQuickAmountsCents: [3_000, 5_000, 10_000],
        receptionDefaultMethod: 'card',
        feedbackSound: false,
      },
    });
  });

  it('0 € = siempre con PIN; con céntimos también vale', () => {
    expect(nightChange({ ...nightFormFrom(current), noPinMaxEur: '0', noPinNightCapEur: '0' }, current)).toEqual({
      ok: true,
      change: { nfcNoPinMaxCents: 0, nfcNoPinNightCapCents: 0 },
    });
    expect(nightChange({ ...nightFormFrom(current), noPinMaxEur: '12,50' }, current)).toMatchObject({ change: { nfcNoPinMaxCents: 1_250 } });
  });

  it('lo que no vale: más de 50 € sin PIN, más de 500 € por noche, un tope menor que el máximo o importes raros', () => {
    const base = nightFormFrom(current);
    expect(nightChange({ ...base, noPinMaxEur: '60' }, current)).toMatchObject({ ok: false, problem: expect.stringMatching(/50 €/) });
    expect(nightChange({ ...base, noPinNightCapEur: '600' }, current)).toMatchObject({ ok: false });
    expect(nightChange({ ...base, noPinNightCapEur: '10' }, current)).toMatchObject({ ok: false, problem: expect.stringMatching(/tope/) });
    expect(nightChange({ ...base, quickAmountsEur: '' }, current)).toMatchObject({ ok: false });
    expect(nightChange({ ...base, noPinMaxEur: 'veinte' }, current)).toMatchObject({ ok: false });
  });

  it('importes rápidos: de 1 a 4, enteros, ordenados y sin repetir', () => {
    expect(parseQuickAmounts('20, 50, 100')).toEqual([2_000, 5_000, 10_000]);
    expect(parseQuickAmounts('50 20 20 €')).toEqual([2_000, 5_000]);
    expect(parseQuickAmounts('10, 20, 30, 40, 50')).toBeNull();
    expect(parseQuickAmounts('0')).toBeNull();
    expect(parseQuickAmounts('1000')).toBeNull();
    expect(quickAmountsText([2_000, 5_000])).toBe('20, 50');
    expect(eurosText(1_250)).toBe('12,50');
  });

  it('la línea de ayuda dice lo guardado', () => {
    expect(noPinSummary(current)).toBe('Ahora: sin PIN hasta 20 € por cobro y 100 € por noche.');
    expect(noPinSummary({ nfcNoPinMaxCents: 0, nfcNoPinNightCapCents: 100_00 })).toBe('Ahora: siempre con PIN.');
  });
});
