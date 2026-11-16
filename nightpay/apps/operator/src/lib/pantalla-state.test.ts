import { describe, it, expect } from 'vitest';
import type { CustomerScreenView } from '@nightpay/contracts';
import {
  ENDED_SHOW_MS,
  INITIAL_MEMORY,
  PAID_SHOW_MS,
  amountText,
  cardLine,
  expireMemory,
  idleHint,
  nextMemory,
  tipBreakdown,
  tipButtonLabel,
  waitingHint,
  type PantallaMemory,
  type WaitingView,
} from './pantalla-state';

const base = { venueName: 'Sala Luna', fichas: true, pairedUntil: '2026-11-18T11:00:00.000Z' };
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
