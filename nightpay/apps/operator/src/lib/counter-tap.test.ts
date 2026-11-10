import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReceptionDeskSaldo } from '@nightpay/contracts';
import { counterFicha, counterTapText, sameCounterCard } from './counter-tap';

const NUEVA = { kind: 'new' as const, fichaNumber: 7, printedNumber: '00001013' };
const SALDO = {
  kind: 'saldo',
  walletId: 'w',
  code: 'K7Q-4M2',
  balanceCents: 3_500,
  hasPin: true,
  isHomeVenue: true,
  blocked: false,
  closeRequested: false,
  cashOutCents: 0,
  cashOutNote: null,
  fichaNumber: 7,
  printedNumber: '00001013',
} satisfies ReceptionDeskSaldo;
const MIA = 'tok-mia-0123456789AB';
const OTRA = 'tok-otra-0123456789A';

describe('el lector en el mostrador (A3)', () => {
  it('la ficha leída: su código grabado y su número', () => {
    expect(counterFicha({ view: NUEVA, nfc: { card: MIA } })).toEqual({ card: MIA, printed: '00001013' });
    expect(counterFicha({ view: SALDO, nfc: null })).toEqual({ card: null, printed: '00001013' });
    expect(counterFicha({ view: null, nfc: null, number: { printedNumber: '0042' } })).toEqual({ card: null, printed: '0042' });
    // Un saldo sin ficha (por el código) o un saldo nuevo sin ficha: cualquiera es otra.
    expect(counterFicha({ view: { ...SALDO, fichaNumber: null }, nfc: null })).toEqual({ card: null, printed: null });
    expect(counterFicha({ view: null, nfc: null })).toEqual({ card: null, printed: null });
  });

  it('con la misma ficha no pasa nada (sin preguntar al servidor)', () => {
    const here = counterFicha({ view: NUEVA, nfc: { card: MIA } });
    expect(sameCounterCard(here, MIA)).toBe(true);
    expect(counterTapText(here, { token: MIA, printed: null })).toBeNull();
  });

  it('con otra, solo el aviso: «Esa es la 1014, no la 1013»', () => {
    const here = counterFicha({ view: NUEVA, nfc: { card: MIA } });
    expect(sameCounterCard(here, OTRA)).toBe(false);
    expect(counterTapText(here, { token: OTRA, printed: '00001014' })).toBe('Esa es la 1014, no la 1013');
    // Aunque lleve el mismo número impreso (otro grupo de locales), con otro código es otra ficha.
    expect(counterTapText(here, { token: OTRA, printed: '00001013' })).toBe('Esa es la 1013, no la 1013');
    // En blanco o de otro local: no se sabe su número.
    expect(counterTapText(here, { token: null, printed: null })).toBe('Esa no es la 1013');
  });

  it('por el número o por el código (sin código grabado): vale el mismo número impreso', () => {
    const here = counterFicha({ view: null, nfc: null, number: { printedNumber: '1013' } });
    expect(counterTapText(here, { token: OTRA, printed: '00001013' })).toBeNull();
    expect(counterTapText(here, { token: OTRA, printed: '00001014' })).toBe('Esa es la 1014, no la 1013');
  });

  it('sin ficha: cualquiera es otra', () => {
    expect(counterTapText({ card: null, printed: null }, { token: OTRA, printed: '0099' })).toBe('Esa es la 99: no es la de este cliente');
  });

  it('el mostrador escucha fuera de la primera pantalla sin grabar, cargar ni cambiar de pantalla', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const handler = desk.slice(desk.indexOf('async function onCounterTap('), desk.indexOf('function onCode('));
    expect(handler).not.toMatch(/\bgo\(|setStep\(|restart\(|staffBackend\.(stock|cash|link)|payCash|sendCash/);
    // Solo se graba una ficha en blanco en la primera pantalla.
    expect(desk).toMatch(/useDeskNfc\([\s\S]*?mode === 'entrada' && step\.kind === 'tap'/);
  });
});
