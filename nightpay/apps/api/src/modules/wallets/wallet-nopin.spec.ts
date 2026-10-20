import { describe, it, expect } from 'vitest';
import { DEFAULT_NIGHT_SETTINGS, PIN_REQUIRED_CODE } from '@nightpay/contracts';
import { PinRequiredException, noPinCardProblem, noPinProblem, noPinSpentSince, noPinWindowStart } from './wallet-nopin';

/** NFC sin PIN: hasta 20 € por cobro y 100 € por noche (de fábrica), la noche de 08:00 a 08:00 de Madrid. */

const limits = DEFAULT_NIGHT_SETTINGS;

describe('¿va sin PIN? (máximo por cobro y tope de la noche)', () => {
  it('hasta 20 € por cobro, 20 € incluidos; 20,01 € pide el PIN', () => {
    expect(noPinProblem({ amountCents: 1_500, spentCents: 0, limits })).toBeNull();
    expect(noPinProblem({ amountCents: 2_000, spentCents: 0, limits })).toBeNull();
    expect(noPinProblem({ amountCents: 2_001, spentCents: 0, limits })).toBe('over_max');
  });

  it('el tope de la noche: con 80 € gastados sin PIN, 20 € más caben y 20,01 € no', () => {
    expect(noPinProblem({ amountCents: 2_000, spentCents: 8_000, limits })).toBeNull();
    expect(noPinProblem({ amountCents: 2_000, spentCents: 8_001, limits })).toBe('night_cap');
    expect(noPinProblem({ amountCents: 100, spentCents: 10_000, limits })).toBe('night_cap');
  });

  it('un local con el máximo o el tope a 0: siempre con PIN', () => {
    expect(noPinProblem({ amountCents: 100, spentCents: 0, limits: { ...limits, nfcNoPinMaxCents: 0 } })).toBe('off');
    expect(noPinProblem({ amountCents: 100, spentCents: 0, limits: { ...limits, nfcNoPinNightCapCents: 0 } })).toBe('off');
  });

  it('los topes del local mandan (p. ej. 10 € por cobro y 30 € por noche)', () => {
    const own = { nfcNoPinMaxCents: 1_000, nfcNoPinNightCapCents: 3_000 };
    expect(noPinProblem({ amountCents: 1_200, spentCents: 0, limits: own })).toBe('over_max');
    expect(noPinProblem({ amountCents: 1_000, spentCents: 2_000, limits: own })).toBeNull();
    expect(noPinProblem({ amountCents: 1_000, spentCents: 2_500, limits: own })).toBe('night_cap');
  });
});

describe('desde cuándo se cuenta (la noche de Madrid y el último PIN bueno)', () => {
  it('a las 02:10 del sábado cuenta desde las 08:00 del viernes; a las 08:00 empieza otra noche', () => {
    expect(noPinWindowStart(new Date('2026-10-17T02:10:00+02:00'), null)).toEqual(new Date('2026-10-16T08:00:00+02:00'));
    expect(noPinWindowStart(new Date('2026-10-17T07:59:59+02:00'), null)).toEqual(new Date('2026-10-16T08:00:00+02:00'));
    expect(noPinWindowStart(new Date('2026-10-17T08:00:00+02:00'), null)).toEqual(new Date('2026-10-17T08:00:00+02:00'));
  });

  it('cambio de hora (25-oct-2026, a las 03:00 vuelven a ser las 02:00): la noche sigue empezando a las 08:00 locales', () => {
    // 08:00 en verano (UTC+2) el sábado; a las 05:00 del domingo ya es invierno (UTC+1).
    expect(noPinWindowStart(new Date('2026-10-25T05:00:00+01:00'), null)).toEqual(new Date('2026-10-24T08:00:00+02:00'));
    expect(noPinWindowStart(new Date('2026-10-25T09:00:00+01:00'), null)).toEqual(new Date('2026-10-25T08:00:00+01:00'));
  });

  it('tras un PIN bueno esta noche, desde el PIN; un PIN de la noche anterior no cuenta', () => {
    const now = new Date('2026-10-17T02:10:00+02:00');
    const pin = new Date('2026-10-17T01:00:00+02:00');
    expect(noPinWindowStart(now, pin)).toEqual(pin);
    expect(noPinWindowStart(now, new Date('2026-10-16T03:00:00+02:00'))).toEqual(new Date('2026-10-16T08:00:00+02:00'));
  });
});

describe('el NFC tiene que ser el original (número de serie)', () => {
  it('con el número de serie leído y guardado iguales, sí; sin uno de los dos, PIN', () => {
    expect(noPinCardProblem({ uid: '04A23B1C2D5E80' }, '04A23B1C2D5E80')).toBeNull();
    // Un iPhone no lee el número de serie.
    expect(noPinCardProblem({ uid: '04A23B1C2D5E80' }, null)).toBe('no_uid');
    // Un NFC dado sin guardar su número de serie: no se puede saber si es una copia.
    expect(noPinCardProblem({ uid: null }, '04A23B1C2D5E80')).toBe('no_uid');
    expect(noPinCardProblem({ uid: '04A23B1C2D5E80' }, '04FFFFFFFFFFFF')).toBe('no_uid');
  });

  it('el 409 dice PIN_REQUIRED, el porqué y un texto para la chica', () => {
    const err = new PinRequiredException('night_cap');
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: PIN_REQUIRED_CODE, reason: 'night_cap', message: expect.stringMatching(/tope/) });
  });
});

describe('lo gastado sin PIN (SQL)', () => {
  it('solo lo cobrado sin PIN, sin anulados, de estos saldos y desde ese momento', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join('?'), values });
        return [{ total: 3_500 }];
      },
    };
    const since = new Date('2026-10-16T08:00:00+02:00');
    await expect(noPinSpentSince(tx as never, ['w-1', 'w-2'], since)).resolves.toBe(3_500);
    expect(calls[0]!.text).toMatch(/"authMethod" = 'nfc_nopin'/);
    expect(calls[0]!.text).toMatch(/"reversedAt" IS NULL/);
    expect(calls[0]!.values).toEqual([['w-1', 'w-2'], since]);
    const empty = { $queryRaw: async () => [] };
    await expect(noPinSpentSince(empty as never, ['w-1'], since)).resolves.toBe(0);
  });
});
