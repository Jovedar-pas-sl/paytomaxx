import { describe, expect, it } from 'vitest';
import {
  GIVEN_BILLS,
  PARTY_DEFAULT_AMOUNT,
  PARTY_QUICK_AMOUNTS,
  changeCents,
  givenOptions,
  initialMethod,
  isQuickAmount,
  keepGiven,
  loadedRows,
  pulseraCard,
  shortEur,
  taquillaCta,
} from './party-taquilla';

// Intl separa la cifra del «€» con un espacio que no se parte (U+00A0).
const nb = (text: string) => text.replace(/ €/g, '\u00a0€');

describe('OxioParty · taquilla: los importes', () => {
  it('10, 20 y 50 € (y «Otro»); de entrada, 20 €', () => {
    expect(PARTY_QUICK_AMOUNTS).toEqual([1000, 2000, 5000]);
    expect(PARTY_DEFAULT_AMOUNT).toBe(2000);
    expect(PARTY_QUICK_AMOUNTS.map((c) => shortEur(c))).toEqual([nb('10 €'), nb('20 €'), nb('50 €')]);
    expect(isQuickAmount(2000)).toBe(true);
    expect(isQuickAmount(3000)).toBe(false);
  });
});

describe('OxioParty · taquilla: el cambio', () => {
  it('«Te da» con 20, 50 y 100 €', () => {
    expect(GIVEN_BILLS).toEqual([2000, 5000, 10000]);
  });

  it('carga 20 € y le da 50 €: 30 € de cambio; con el billete justo, 0', () => {
    expect(changeCents(2000, 5000)).toBe(3000);
    expect(changeCents(2000, 2000)).toBe(0);
    expect(changeCents(5000, 10000)).toBe(5000);
  });

  it('con comisión del servicio, el cambio sale de lo que paga (21,20 € con 50 €: 28,80 €)', () => {
    expect(changeCents(2120, 5000)).toBe(2880);
  });

  it('sin billete marcado, o si no le llega, no hay cambio', () => {
    expect(changeCents(2000, null)).toBeNull();
    expect(changeCents(5000, 2000)).toBeNull();
  });

  it('los billetes que no llegan, apagados; el marcado se quita si ya no llega', () => {
    expect(givenOptions(5000)).toEqual([
      { cents: 2000, enough: false },
      { cents: 5000, enough: true },
      { cents: 10000, enough: true },
    ]);
    expect(keepGiven(2000, 5000)).toBeNull();
    expect(keepGiven(5000, 2000)).toBe(5000);
    expect(keepGiven(null, 2000)).toBeNull();
  });
});

describe('OxioParty · taquilla: el botón dice lo que hace', () => {
  it('«Cargar 20 € en efectivo» o «Cobrar 20 € con tarjeta»', () => {
    expect(taquillaCta('cash', 2000)).toBe(nb('Cargar 20 € en efectivo'));
    expect(taquillaCta('card', 2000)).toBe(nb('Cobrar 20 € con tarjeta'));
    expect(taquillaCta('cash', 1250)).toBe(nb('Cargar 12,50 € en efectivo'));
  });

  it('marca de entrada la forma que se puede usar (la de por defecto va primera)', () => {
    expect(
      initialMethod([
        { method: 'card', primary: true, problem: null },
        { method: 'cash', primary: false, problem: null },
      ]),
    ).toBe('card');
    expect(
      initialMethod([
        { method: 'cash', primary: true, problem: 'En efectivo, como mucho 999,99 € por recarga.' },
        { method: 'card', primary: false, problem: null },
      ]),
    ).toBe('card');
    expect(initialMethod([])).toBeNull();
  });
});

describe('OxioParty · taquilla: el detalle de CARGADO', () => {
  it('en efectivo: la pulsera, el saldo y el cambio a devolver', () => {
    expect(loadedRows({ pulsera: 'P-0412', balanceCents: 2000, method: 'cash', changeCents: 3000 })).toEqual([
      { label: 'Pulsera', value: 'P-0412' },
      { label: 'Saldo ahora', value: nb('20,00 €') },
      { label: 'Cambio a devolver', value: nb('30,00 €') },
    ]);
  });

  it('con tarjeta: «Pagado con Tarjeta»; lo que no se sabe no sale', () => {
    expect(loadedRows({ pulsera: null, balanceCents: null, method: 'card', changeCents: null })).toEqual([{ label: 'Pagado con', value: 'Tarjeta' }]);
    expect(loadedRows({ pulsera: 'P-1', balanceCents: 500, method: 'cash', changeCents: null })).toEqual([
      { label: 'Pulsera', value: 'P-1' },
      { label: 'Saldo ahora', value: nb('5,00 €') },
    ]);
  });
});

describe('OxioParty · taquilla: la pulsera leída', () => {
  const saldo = {
    kind: 'saldo' as const,
    printedNumber: '00000412',
    walletId: 'w1',
    code: 'K7Q-4M2',
    balanceCents: 1200,
    hasPin: false,
    isHomeVenue: true,
    blocked: false,
    closeRequested: false,
    cashOutCents: 0,
    cashOutNote: null,
    fichaNumber: 412,
  };

  it('nueva: su número y «Nueva», sin saldo', () => {
    expect(pulseraCard({ view: { kind: 'new', printedNumber: '00000412', fichaNumber: 412 } })).toEqual({
      title: 'Pulsera 412',
      isNew: true,
      detail: nb('Saldo 0,00 €'),
    });
    expect(pulseraCard({ view: { kind: 'new', printedNumber: null, fichaNumber: 9 } }).title).toBe('Pulsera nueva');
  });

  it('con saldo: lo que tiene y su código', () => {
    expect(pulseraCard({ view: saldo })).toEqual({ title: 'Pulsera 412', isNew: false, detail: nb('Saldo 12,00 € · K7Q-4M2') });
  });

  it('un saldo sin pulsera (por su código) y un saldo nuevo sin pulsera', () => {
    expect(pulseraCard({ view: { ...saldo, fichaNumber: null } }).title).toBe('Saldo K7Q-4M2');
    expect(pulseraCard({ view: null })).toEqual({ title: 'Saldo nuevo', isNew: true, detail: 'Sin pulsera: se queda con su código' });
  });
});
