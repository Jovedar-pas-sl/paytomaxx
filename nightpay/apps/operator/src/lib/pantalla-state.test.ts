import { describe, it, expect } from 'vitest';
import type { CustomerScreenView } from '@nightpay/contracts';
import {
  ENDED_SHOW_MS,
  INITIAL_MEMORY,
  PAID_SHOW_MS,
  amountText,
  cardLine,
  isOtherTip,
  otherTipMaxText,
  otherTipOf,
  otherTipOffered,
  expireMemory,
  idleHint,
  nextMemory,
  REST_SHIFT_MS,
  restOf,
  restShift,
  tipBreakdown,
  tipButtonLabel,
  waitingHint,
  type PantallaMemory,
  type WaitingView,
} from './pantalla-state';

const base = {
  venueName: 'Sala Luna',
  fichas: true,
  message: { line1: null, line2: null },
  pairedUntil: '2026-11-18T11:00:00.000Z',
};
const idle: CustomerScreenView = { ...base, state: 'idle' };
function waiting(key = 'k1', over: Partial<WaitingView> = {}): WaitingView {
  return {
    ...base,
    state: 'waiting',
    key,
    currency: 'EUR',
    amountCents: 3300,
    totalCents: 3300,
    cardAmountCents: null,
    qrUrl: 'https://api.oxio.test/pay/tok',
    tip: { presets: [{ cents: 200, percent: null }, { cents: 500, percent: null }], maxCents: 3300, chosenCents: 0, toStaff: false },
    pinKeypad: 'fixed',
    noPinMaxCents: 2000,
    ficha: true,
    paying: false,
    topUp: false,
    ...over,
  };
}
const paid = (key = 'k1'): CustomerScreenView => ({ ...base, state: 'paid', key });
const ended = (key = 'k1', reason: 'canceled' | 'expired' | 'failed' = 'canceled'): CustomerScreenView => ({
  ...base,
  state: 'ended',
  key,
  reason,
});

function feed(views: CustomerScreenView[], now = 1000): PantallaMemory {
  return views.reduce((mem, view) => nextMemory(mem, view, now), INITIAL_MEMORY);
}

describe('pantalla del cliente: qué se enseña y cuánto rato', () => {
  it('esperando → «Pagado» unos segundos → reposo solo', () => {
    let mem = feed([idle, waiting()]);
    expect(mem.shown.kind).toBe('waiting');
    mem = nextMemory(mem, paid(), 2000);
    expect(mem.shown).toEqual({ kind: 'paid', until: 2000 + PAID_SHOW_MS });
    // El camarero ya salió del cobro (el API dice reposo o sigue diciendo pagado): el «Pagado» sigue.
    expect(nextMemory(mem, idle, 3000).shown.kind).toBe('paid');
    expect(nextMemory(mem, paid(), 3000).shown.kind).toBe('paid');
    expect(expireMemory(mem, 2000 + PAID_SHOW_MS - 1).shown.kind).toBe('paid');
    mem = expireMemory(mem, 2000 + PAID_SHOW_MS);
    expect(mem.shown).toEqual({ kind: 'idle', note: null, until: null });
    // El API aún dice pagado de ese cobro: no se repite.
    expect(nextMemory(mem, paid(), 9000).shown.kind).toBe('idle');
  });

  it('un cobro nuevo corta el «Pagado» del anterior', () => {
    const mem = nextMemory(feed([waiting('k1'), paid('k1')]), waiting('k2'), 1500);
    expect(mem.shown).toMatchObject({ kind: 'waiting', view: { key: 'k2' } });
  });

  it('cancelado, caducado o fallido: reposo con un texto corto que se va solo', () => {
    for (const [reason, note] of [
      ['canceled', 'Cobro cancelado'],
      ['expired', 'El QR ha caducado'],
      ['failed', 'No se ha podido pagar'],
    ] as const) {
      const mem = feed([waiting(), ended('k1', reason)]);
      expect(mem.shown).toEqual({ kind: 'idle', note, until: 1000 + ENDED_SHOW_MS });
      expect(expireMemory(mem, 1000 + ENDED_SHOW_MS).shown).toEqual({ kind: 'idle', note: null, until: null });
    }
  });

  it('al abrirse (o recargar) no enseña el final de un cobro que no vio esperando', () => {
    expect(feed([paid('viejo')]).shown).toEqual({ kind: 'idle', note: null, until: null });
    expect(feed([ended('viejo')]).shown).toEqual({ kind: 'idle', note: null, until: null });
  });

  it('textos: reposo, qué hacer, importe y lo que paga la tarjeta', () => {
    expect(idleHint(true)).toBe('Paga con tu ficha o con el QR');
    expect(idleHint(false)).toBe('Paga con el QR');
    expect(waitingHint(waiting())).toBe('Acerca tu ficha al móvil del camarero');
    expect(waitingHint(waiting('k', { ficha: false }))).toBe('Escanea el QR con tu móvil');
    expect(waitingHint(waiting('k', { paying: true, qrUrl: null }))).toBe('Terminando el pago…');
    expect(waitingHint(waiting('k', { ficha: false, qrUrl: null }))).toBe('Paga en el datáfono');
    expect(amountText(waiting())).toMatch(/^33\s?€$/);
    expect(cardLine(waiting())).toBeNull();
    expect(cardLine(waiting('k', { cardAmountCents: 3630 }))).toMatch(/^Con tarjeta, 36,30\s?€$/);
  });

  it('la ficha en esta tablet (Web NFC) o en el móvil del camarero', () => {
    expect(waitingHint(waiting(), true)).toBe('Acerca tu ficha a esta pantalla o al móvil del camarero');
    expect(waitingHint(waiting(), false)).toBe('Acerca tu ficha al móvil del camarero');
  });

  it('propina: el total la suma, se desglosa y los botones dicen cuánto', () => {
    const chosen = waiting('k', { totalCents: 3800, tip: { ...waiting().tip!, chosenCents: 500 } });
    expect(amountText(chosen)).toMatch(/^38\s?€$/);
    expect(tipBreakdown(chosen)).toMatch(/^33\s?€ \+ 5\s?€ de propina$/);
    expect(tipBreakdown(waiting())).toBeNull();
    expect(tipButtonLabel({ cents: 200, percent: null })).toMatch(/^\+2\s?€$/);
    expect(tipButtonLabel({ cents: 1000, percent: 10 })).toMatch(/^10 % · \+10\s?€$/);
  });
});

describe('«Otra» propina en la tablet (como npTipOther en /pay)', () => {
  it('euros enteros, más de 0 y hasta el tope', () => {
    expect(otherTipOf('7', 3300)).toEqual({ cents: 700, error: null });
    expect(otherTipOf('33', 3300)).toEqual({ cents: 3300, error: null });
    expect(otherTipOf('34', 3300)).toEqual({ cents: 0, error: 'max' });
    expect(otherTipOf('', 3300)).toEqual({ cents: 0, error: 'empty' });
    expect(otherTipOf('0', 3300)).toEqual({ cents: 0, error: 'empty' });
    expect(otherTipMaxText(3350)).toMatch(/^Como mucho 33\s?€$/);
  });

  it('marcada como «Otra» si no es una sugerida; se ofrece si cabe 1 €; con propina, la ficha pide el PIN', () => {
    const base = waiting();
    const other = { ...base, tip: { ...base.tip!, chosenCents: 700 } };
    expect(isOtherTip(other)).toBe(true);
    expect(isOtherTip({ ...base, tip: { ...base.tip!, chosenCents: 500 } })).toBe(false);
    expect(isOtherTip(base)).toBe(false);
    expect(otherTipOffered(base)).toBe(true);
    expect(otherTipOffered({ ...base, tip: { ...base.tip!, maxCents: 50 } })).toBe(false);
    expect(waitingHint(other, true)).toBe('Acerca tu ficha a esta pantalla o al móvil del camarero y pon tu PIN');
  });
});

describe('pantalla del cliente: el reposo', () => {
  it('el nombre del local, cómo se paga y el mensaje que puso el local (de cualquier vista)', () => {
    const message = { line1: '2x1 en copas hasta la 1', line2: 'Sábado: fiesta blanca' };
    expect(restOf({ ...idle, message })).toEqual({ name: 'Sala Luna', fichas: true, line1: message.line1, line2: message.line2 });
    expect(restOf({ ...waiting(), fichas: false, message: { line1: 'Hoy DJ', line2: null } })).toEqual({
      name: 'Sala Luna',
      fichas: false,
      line1: 'Hoy DJ',
      line2: null,
    });
    expect(restOf(idle)).toMatchObject({ line1: null, line2: null });
  });

  it('con un API de antes (sin mensaje) o solo con la segunda línea: lo que se pueda enseñar', () => {
    const { message: _old, ...before } = idle as Extract<CustomerScreenView, { state: 'idle' }>;
    expect(restOf(before as CustomerScreenView)).toEqual({ name: 'Sala Luna', fichas: true, line1: null, line2: null });
    expect(restOf({ ...idle, message: { line1: null, line2: 'Solo esta' } })).toMatchObject({ line1: 'Solo esta', line2: null });
  });

  it('se mueve un poco cada minuto (que no se quede marcado): cerca del centro, sin repetir enseguida', () => {
    expect(REST_SHIFT_MS).toBe(60_000);
    const shifts = Array.from({ length: 16 }, (_, i) => restShift(i));
    for (const { x, y } of shifts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(2);
      expect(Math.abs(y)).toBeLessThanOrEqual(2);
    }
    // Cada minuto en otro sitio, y vuelta a empezar a los 8.
    for (let i = 1; i < shifts.length; i += 1) expect(shifts[i]).not.toEqual(shifts[i - 1]);
    expect(new Set(shifts.slice(0, 8).map((p) => `${p.x},${p.y}`)).size).toBe(8);
    expect(restShift(8)).toEqual(restShift(0));
    expect(restShift(-1)).toEqual(restShift(7));
  });
});
