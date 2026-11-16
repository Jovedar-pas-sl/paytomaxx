import { describe, expect, it } from 'vitest';
import {
  AT_BANK_PAYING_TEXT,
  AT_BANK_SLOW_TEXT,
  CANCEL_AT_BANK_TEXT,
  CANCEL_TOO_SOON_TEXT,
  bankCancel,
  cancelTooSoonText,
  cancelableAtFrom,
  withCancelableAt,
} from './cancel-at-bank';

const T0 = Date.parse('2026-11-16T23:40:00.000Z');

describe('«Cancelar cobro» con el cliente en su banco (decisión del dueño)', () => {
  it('los textos de la pantalla, tal cual', () => {
    expect(AT_BANK_PAYING_TEXT).toBe('El cliente está pagando en su banco');
    expect(AT_BANK_SLOW_TEXT).toBe('El banco tarda. Si el cliente no ha pagado, puedes cancelar');
    expect(CANCEL_AT_BANK_TEXT).toBe('Si su banco lo cobra después, te avisaremos para devolverlo');
  });

  it('fuera del banco, el botón como siempre; en su banco, los primeros 2 minutos no; después, sí', () => {
    const at = cancelableAtFrom(T0);
    expect(at).toBe(T0 + 120_000);
    expect(bankCancel(false, null, T0)).toBe('free');
    expect(bankCancel(true, at, T0 + 30_000)).toBe('wait');
    expect(bankCancel(true, at, T0 + 119_999)).toBe('wait');
    expect(bankCancel(true, at, T0 + 120_000)).toBe('late');
    expect(bankCancel(true, at, T0 + 600_000)).toBe('late');
  });

  it('en su banco sin saber desde cuándo: no se ofrece (aún)', () => {
    expect(cancelableAtFrom(null)).toBeNull();
    expect(cancelableAtFrom(Number.NaN)).toBeNull();
    expect(bankCancel(true, null, T0)).toBe('wait');
  });

  it('el 409 del API (el reloj de este móvil iba adelantado) tiene su texto; otro error, no', () => {
    expect(cancelTooSoonText('CANCEL_AT_BANK_TOO_SOON')).toBe(CANCEL_TOO_SOON_TEXT);
    expect(cancelTooSoonText('BITCOIN_CONFIRMING')).toBeNull();
    expect(cancelTooSoonText(null)).toBeNull();
  });
});

describe('la lista «Sin pagar»: la hora a la que se podrá cancelar, sin parpadeos', () => {
  const row = (o: Partial<{ id: string; atBank: boolean; atBankSince: string | null; cancelableInMs: number }> = {}) => ({
    id: 'c1',
    atBank: true,
    atBankSince: '2026-11-16T23:39:30.000Z',
    cancelableInMs: 90_000,
    ...o,
  });

  it('desde que llegó la respuesta: lo que faltaba (con el reloj de este móvil, no el del servidor)', () => {
    const [a] = withCancelableAt(null, [row()], T0);
    expect(a!.cancelableAtMs).toBe(T0 + 90_000);
  });

  it('el siguiente sondeo de la misma visita al banco NO mueve la hora (cada respuesta llega unos ms después)', () => {
    const first = withCancelableAt(null, [row()], T0);
    const second = withCancelableAt(first, [row({ cancelableInMs: 79_400 })], T0 + 10_000);
    expect(second[0]!.cancelableAtMs).toBe(T0 + 90_000);
    // Ni cuando el servidor ya dice 0 un poco antes que este móvil.
    const third = withCancelableAt(second, [row({ cancelableInMs: 0 })], T0 + 89_800);
    expect(third[0]!.cancelableAtMs).toBe(T0 + 90_000);
  });

  it('una visita nueva al banco (otro intento, otra hora de salida): cuenta otra vez', () => {
    const first = withCancelableAt(null, [row()], T0);
    const again = withCancelableAt(first, [row({ atBankSince: '2026-11-16T23:42:00.000Z', cancelableInMs: 120_000 })], T0 + 150_000);
    expect(again[0]!.cancelableAtMs).toBe(T0 + 270_000);
  });

  it('abierta a mitad: lo que ya se podía cancelar sale con el botón desde el primer pintado (0)', () => {
    const [a] = withCancelableAt(null, [row({ cancelableInMs: 0 })], T0);
    expect(a!.cancelableAtMs).toBe(0);
    expect(bankCancel(true, a!.cancelableAtMs, T0)).toBe('late');
  });

  it('fuera del banco, sin hora; un API de antes (sin el dato), se puede (decide el servidor)', () => {
    expect(withCancelableAt(null, [row({ atBank: false })], T0)[0]!.cancelableAtMs).toBeNull();
    const old = withCancelableAt(null, [{ id: 'c2', atBank: true }], T0);
    expect(old[0]!.cancelableAtMs).toBe(0);
  });
});
