import { describe, expect, it } from 'vitest';
import {
  MAX_PARTY_HOURS,
  alertsOf,
  buildPartyLive,
  desksOf,
  hourlyOf,
  stallsOf,
  totalsByStall,
  type PartyLiveInput,
  type StallHourRow,
  type StallMeta,
} from './party-live-rules';
import { currentNightWindow, eventNights, eventWindow, nightOf, nightWindow, nightsRange } from './party-windows';

/**
 * En directo con datos de ejemplo (la noche de San Juan, 01:47 de Madrid):
 * vendido = cobros + consumos − devoluciones, cargado por taquilla y desde el
 * móvil, casetas ordenadas con su %, horas seguidas y los avisos.
 */

// 24-jun-2027 01:47 en Madrid (verano, UTC+2) = 23:47 UTC del 23.
const NOW = new Date('2027-06-23T23:47:00Z');
const H = (iso: string) => Math.floor(Date.parse(iso) / 3_600_000);
const at = (iso: string) => new Date(iso);

const META: StallMeta[] = [
  { id: 'canta', name: 'Peña El Cántaro', managerName: 'Ana R.', managerContact: '600000000', organizerBps: 1000, active: true, sortOrder: 0 },
  { id: 'plaza', name: 'Barra de la Plaza', managerName: 'Bar Plaza, S.L.', managerContact: null, organizerBps: 1200, active: true, sortOrder: 1 },
  { id: 'barrio', name: 'Caseta Los del Barrio', managerName: 'Asociación', managerContact: '611111111', organizerBps: 1000, active: true, sortOrder: 2 },
  { id: 'comision', name: 'Barra de la Comisión', managerName: 'La comisión', managerContact: null, organizerBps: 10_000, active: true, sortOrder: 3 },
  { id: 'vieja', name: 'Caseta de prueba', managerName: 'X', managerContact: null, organizerBps: 0, active: false, sortOrder: 4 },
];

function row(stallId: string | null, iso: string, cents: number, count: number, extra: Partial<StallHourRow> = {}): StallHourRow {
  return { stallId, hour: H(iso), cents, count, lastAt: count > 0 ? at(iso) : null, refundedCents: 0, lastHourCents: 0, ...extra };
}

const SALES: StallHourRow[] = [
  row('canta', '2027-06-23T21:10:00Z', 120_000, 40),
  row('canta', '2027-06-23T23:45:00Z', 264_000, 60, { lastHourCents: 50_000 }),
  row('plaza', '2027-06-23T23:46:00Z', 321_000, 98, { lastHourCents: 30_000 }),
  // Los del Barrio: lo último a las 23:20 UTC (27 min sin cobrar).
  row('barrio', '2027-06-23T23:20:00Z', 246_000, 70, { lastHourCents: 10_000 }),
  // Una devolución de 5 € en la Comisión (resta dinero, no cobros).
  row('comision', '2027-06-23T22:30:00Z', 158_000, 51),
  row('comision', '2027-06-23T23:10:00Z', -500, 0, { refundedCents: 500, lastHourCents: -500 }),
  // Lo de quien no tiene caseta.
  row(null, '2027-06-23T22:05:00Z', 2_000, 1),
];

const PEOPLE = new Map([
  ['u-1', 'Lucía'],
  ['u-2', 'Marcos'],
]);
const TERMINALS = new Map([['t-1', 'Taquilla norte (datáfono)']]);

function input(extra: Partial<PartyLiveInput> = {}): PartyLiveInput {
  return {
    scope: 'night',
    night: '2027-06-23',
    window: currentNightWindow(NOW),
    now: NOW,
    idleMinutes: 15,
    event: { name: 'Fiestas de San Juan', startsAt: at('2027-06-23T18:00:00Z'), endsAt: at('2027-06-25T04:00:00Z'), ended: false, nights: [] },
    cashAlertCents: 200_000,
    stallMeta: META,
    sales: SALES,
    card: [
      { kind: 'person', who: 'u-1', cents: 418_000, count: 120, lastHourCents: 40_000 },
      { kind: 'terminal', who: 't-1', cents: 312_000, count: 80, lastHourCents: 20_000 },
      { kind: 'phone', who: null, cents: 260_000, count: 52, lastHourCents: 10_000 },
    ],
    cash: [
      { kind: 'person', who: 'u-1', cents: 624_000, feeCents: 0, count: 300, lastHourCents: 50_000 },
      { kind: 'person', who: 'u-2', cents: 231_000, feeCents: 0, count: 100, lastHourCents: 4_000 },
      { kind: 'terminal', who: 't-1', cents: 10_000, feeCents: 1_200, count: 2, lastHourCents: 0 },
    ],
    payouts: [{ who: 'u-1', cents: 4_000, count: 2 }],
    people: PEOPLE,
    terminals: TERMINALS,
    wristbands: { balanceCents: 433_000, active: 1212 },
    ...extra,
  };
}

describe('buildPartyLive con una noche de ejemplo', () => {
  const live = buildPartyLive(input());

  it('cargado: efectivo, tarjeta en taquilla y desde el móvil (recargas, nunca venta)', () => {
    expect(live.loaded).toEqual({
      totalCents: 624_000 + 231_000 + 10_000 + 418_000 + 312_000 + 260_000,
      cashCents: 865_000,
      cardCents: 730_000,
      phoneCents: 260_000,
      count: 300 + 100 + 2 + 120 + 80 + 52,
    });
  });

  it('vendido = cobros + consumos − devoluciones (cobros sin las devoluciones)', () => {
    expect(live.sold).toEqual({
      totalCents: 120_000 + 264_000 + 321_000 + 246_000 + 158_000 - 500 + 2_000,
      count: 40 + 60 + 98 + 70 + 51 + 1,
      refundedCents: 500,
    });
    expect(live.lastHour).toEqual({ loadedCents: 40_000 + 20_000 + 10_000 + 50_000 + 4_000, soldCents: 50_000 + 30_000 + 10_000 - 500 });
    expect(live.inWristbandsCents).toBe(433_000);
    expect(live.activeWristbands).toBe(1212);
  });

  it('las casetas por lo vendido, con su %; la desactivada sin ventas no sale; «Sin caseta» al final', () => {
    expect(live.stalls.map((s) => [s.name, s.soldCents, s.count])).toEqual([
      ['Peña El Cántaro', 384_000, 100],
      ['Barra de la Plaza', 321_000, 98],
      ['Caseta Los del Barrio', 246_000, 70],
      ['Barra de la Comisión', 157_500, 51],
      ['Sin caseta', 2_000, 1],
    ]);
    expect(live.stalls[0]).toMatchObject({ organizerBps: 1000, ownBar: false, lastAt: '2027-06-23T23:45:00.000Z', idle: false });
    expect(live.stalls[3]).toMatchObject({ ownBar: true, organizerBps: 10_000 });
    expect(live.stalls.at(-1)).toMatchObject({ id: null, organizerBps: null, idle: false });
  });

  it('una caseta lleva 15 min sin cobrar mientras otras cobran: parada (y su aviso, con su responsable)', () => {
    const idle = live.stalls.filter((s) => s.idle).map((s) => s.name);
    // Los del Barrio (27 min) y la Comisión (77 min); la Plaza cobró hace 1 min.
    expect(idle).toEqual(['Caseta Los del Barrio', 'Barra de la Comisión']);
    expect(live.alerts.filter((a) => a.kind === 'STALL_IDLE')).toEqual([
      { kind: 'STALL_IDLE', stallId: 'barrio', name: 'Caseta Los del Barrio', minutes: 27, managerName: 'Asociación', managerContact: '611111111' },
      { kind: 'STALL_IDLE', stallId: 'comision', name: 'Barra de la Comisión', minutes: 77, managerName: 'La comisión', managerContact: null },
    ]);
  });

  it('las taquillas: cada persona o datáfono con su efectivo y su tarjeta; el móvil al final', () => {
    expect(live.desks).toEqual([
      { key: 'person:u-1', kind: 'person', name: 'Lucía', cashCents: 624_000, cardCents: 418_000, cashInDeskCents: 620_000, count: 420 },
      { key: 'terminal:t-1', kind: 'terminal', name: 'Taquilla norte (datáfono)', cashCents: 10_000, cardCents: 312_000, cashInDeskCents: 11_200, count: 82 },
      { key: 'person:u-2', kind: 'person', name: 'Marcos', cashCents: 231_000, cardCents: 0, cashInDeskCents: 231_000, count: 100 },
      { key: 'phone', kind: 'phone', name: 'Desde el móvil', cashCents: 0, cardCents: 260_000, cashInDeskCents: 0, count: 52 },
    ]);
  });

  it('el aviso de efectivo: las taquillas por encima del umbral, primero (de más a menos)', () => {
    expect(live.alerts.filter((a) => a.kind === 'CASH_OVER')).toEqual([
      { kind: 'CASH_OVER', deskKey: 'person:u-1', name: 'Lucía', cashCents: 620_000, thresholdCents: 200_000 },
      { kind: 'CASH_OVER', deskKey: 'person:u-2', name: 'Marcos', cashCents: 231_000, thresholdCents: 200_000 },
    ]);
    expect(live.alerts[0]?.kind).toBe('CASH_OVER');
  });

  it('las horas, seguidas desde la primera con ventas; la de ahora, abierta', () => {
    expect(live.hourly.map((h) => [h.at.slice(11, 13), h.soldCents, h.open])).toEqual([
      ['21', 120_000, false],
      ['22', 158_000 + 2_000, false],
      ['23', 264_000 + 321_000 + 246_000 - 500, true],
    ]);
  });

  it('la fiesta y sus datos para la cabecera', () => {
    expect(live).toMatchObject({ scope: 'night', night: '2027-06-23', live: true, idleMinutes: 15, cashAlertCents: 200_000 });
    expect(live.event).toMatchObject({ name: 'Fiestas de San Juan', ended: false, startsAt: '2027-06-23T18:00:00.000Z' });
    expect(live.from).toBe('2027-06-23T06:00:00.000Z');
  });
});

describe('cuándo hay avisos', () => {
  it('ni en la fiesta entera, ni en una noche pasada, ni con la fiesta terminada', () => {
    expect(buildPartyLive(input({ scope: 'event', window: eventWindow(NOW, false) })).alerts).toEqual([]);
    expect(buildPartyLive(input({ window: nightWindow('2027-06-22', NOW) })).alerts).toEqual([]);
    const ended = buildPartyLive(input({ event: { ...input().event, ended: true } }));
    expect(ended.alerts).toEqual([]);
    expect(ended.stalls.some((s) => s.idle)).toBe(false);
  });

  it('umbral de efectivo 0: sin aviso de efectivo', () => {
    expect(buildPartyLive(input({ cashAlertCents: 0 })).alerts.every((a) => a.kind === 'STALL_IDLE')).toBe(true);
  });

  it('con toda la fiesta parada (nadie cobra en 15 min), ninguna caseta sale como parada', () => {
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const stalls = stallsOf({ meta: META, totals: totalsByStall(SALES), now: later, idleMinutes: 15, watchIdle: true });
    expect(stalls.some((s) => s.idle)).toBe(false);
  });

  it('una caseta que aún no ha cobrado nada no está «parada» (no hay latido: no se inventa)', () => {
    const stalls = stallsOf({ meta: META, totals: totalsByStall(SALES.filter((r) => r.stallId !== 'barrio')), now: NOW, idleMinutes: 15, watchIdle: true });
    expect(stalls.find((s) => s.id === 'barrio')).toMatchObject({ soldCents: 0, count: 0, lastAt: null, idle: false });
  });

  it('el aviso de 30 min en vez de 15: solo la Comisión', () => {
    const live = buildPartyLive(input({ idleMinutes: 30 }));
    expect(live.alerts.filter((a) => a.kind === 'STALL_IDLE').map((a) => (a.kind === 'STALL_IDLE' ? a.name : ''))).toEqual(['Barra de la Comisión']);
  });

  it('alertsOf sin vigilar, nada', () => {
    expect(alertsOf({ desks: [], stalls: [], cashAlertCents: 1, now: NOW, watch: false })).toEqual([]);
  });
});

describe('las horas', () => {
  it('sin ventas, ninguna', () => {
    expect(hourlyOf([], currentNightWindow(NOW))).toEqual([]);
  });

  it('una noche pasada: hasta la última con ventas, ninguna abierta', () => {
    const w = nightWindow('2027-06-23', new Date('2027-06-26T00:00:00Z'));
    const hours = hourlyOf([row('canta', '2027-06-23T20:00:00Z', 100, 1), row('canta', '2027-06-23T22:00:00Z', 300, 1)], w);
    expect(hours.map((h) => [h.soldCents, h.open])).toEqual([
      [100, false],
      [0, false],
      [300, false],
    ]);
  });

  it('como mucho las últimas dos semanas de horas', () => {
    const hours = hourlyOf([row('canta', '2027-05-01T20:00:00Z', 100, 1)], eventWindow(NOW, false));
    expect(hours).toHaveLength(MAX_PARTY_HOURS);
    expect(hours.at(-1)?.open).toBe(true);
  });
});

describe('las taquillas', () => {
  it('quien solo devolvió saldo en efectivo sale con su caja en negativo; sin nombre, uno genérico', () => {
    const desks = desksOf({ card: [], cash: [], payouts: [{ who: 'u-9', cents: 3_000, count: 1 }], people: new Map(), terminals: new Map() });
    expect(desks).toEqual([{ key: 'person:u-9', kind: 'person', name: 'Persona sin nombre', cashCents: 0, cardCents: 0, cashInDeskCents: -3_000, count: 0 }]);
  });
});

describe('las noches (08:00 a 08:00 de Madrid)', () => {
  it('la noche de un instante: antes de las 08:00, la del día anterior', () => {
    expect(nightOf(new Date('2027-06-24T05:59:00Z'))).toBe('2027-06-23'); // 07:59 Madrid
    expect(nightOf(new Date('2027-06-24T06:00:00Z'))).toBe('2027-06-24'); // 08:00 Madrid
    expect(nightOf(new Date('2027-01-10T06:30:00Z'))).toBe('2027-01-09'); // 07:30 Madrid (invierno)
  });

  it('la ventana de una noche: entera si ya pasó, hasta ahora si sigue, vacía si no ha empezado', () => {
    expect(nightWindow('2027-06-22', NOW)).toEqual({ from: at('2027-06-22T06:00:00Z'), to: at('2027-06-23T06:00:00Z'), live: false });
    expect(nightWindow('2027-06-23', NOW)).toEqual({ from: at('2027-06-23T06:00:00Z'), to: NOW, live: true });
    expect(nightWindow('2027-06-24', NOW)).toEqual({ from: at('2027-06-24T06:00:00Z'), to: at('2027-06-24T06:00:00Z'), live: false });
    expect(nightsRange('2027-06-22', '2027-06-23', NOW)).toEqual({ from: at('2027-06-22T06:00:00Z'), to: NOW, live: true });
    expect(currentNightWindow(NOW)).toEqual({ from: at('2027-06-23T06:00:00Z'), to: NOW, live: true });
    expect(eventWindow(NOW, true)).toEqual({ from: null, to: NOW, live: false });
  });

  it('las noches de la fiesta, con la de ahora marcada', () => {
    expect(eventNights(at('2027-06-23T18:00:00Z'), at('2027-06-25T04:00:00Z'), NOW)).toEqual([
      { day: '2027-06-23', current: true },
      { day: '2027-06-24', current: false },
    ]);
    expect(eventNights(null, null, NOW)).toEqual([]);
    // Sin fin: hasta la de ahora.
    expect(eventNights(at('2027-06-21T18:00:00Z'), null, NOW).map((n) => n.day)).toEqual(['2027-06-21', '2027-06-22', '2027-06-23']);
    // Como mucho 31.
    expect(eventNights(at('2027-01-01T18:00:00Z'), at('2027-06-01T18:00:00Z'), NOW)).toHaveLength(31);
  });
});
