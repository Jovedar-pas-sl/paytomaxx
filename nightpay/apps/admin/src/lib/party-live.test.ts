import { describe, expect, it } from 'vitest';
import { PARTY_NOW, sampleLive } from './party-fixtures';
import {
  DEFAULT_IDLE_MINUTES,
  alertViews,
  dayLabel,
  deskRows,
  eventSubtitle,
  hourAmountLabel,
  hourBars,
  hoursAria,
  idleFromStorage,
  kpisOf,
  liveBadge,
  nightChoices,
  stallRows,
  stallStatus,
  telHref,
} from './party-live';

/** En directo (lógica de la pantalla): cifras, horas, casetas, taquillas y avisos con su acción. */

const TZ = 'Europe/Madrid';
/** Los importes llevan un espacio duro antes del «€»: aquí, uno normal para leerlos. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\u00a0/g, ' ')) as T;

describe('las cifras de arriba', () => {
  it('cargado, vendido, lo que queda en las pulseras (en oscuro) y las pulseras activas; en directo, la última hora', () => {
    const k = plain(kpisOf(sampleLive()));
    expect(k.map((x) => [x.label, x.value, x.dark])).toEqual([
      ['Cargado', '18.450,00 €', false],
      ['Vendido', '14.120,00 €', false],
      ['Aún en las pulseras', '4.330,00 €', true],
      ['Pulseras activas', '1212', false],
    ]);
    expect(k[0]!.hint).toBe('+1.240,00 € en la última hora');
    expect(k[1]!.hint).toBe('+1.640,00 € en la última hora');
  });

  it('una noche cerrada: el desglose en vez de la última hora', () => {
    const k = plain(kpisOf(sampleLive({ live: false, lastHour: null })));
    expect(k[0]!.hint).toBe('Efectivo 8.550,00 € · tarjeta 9.900,00 €');
    expect(k[1]!.hint).toBe('3468 cobros · 5,00 € devuelto');
  });
});

describe('qué noche ver', () => {
  it('«Noche 1», «Noche 2» y «Toda la fiesta»; la de ahora, marcada', () => {
    const c = nightChoices(sampleLive().event.nights, { scope: 'night' }, TZ);
    expect(c.map((x) => [x.label, x.pressed])).toEqual([
      ['Noche 1', true],
      ['Noche 2', false],
      ['Toda la fiesta', false],
    ]);
    expect(c[0]!.title).toBe('Noche del 23 jun');
    expect(c[1]!.selection).toEqual({ scope: 'night', night: '2027-06-24' });
  });

  it('una elegida, o la fiesta entera', () => {
    expect(nightChoices(sampleLive().event.nights, { scope: 'night', night: '2027-06-24' }, TZ).map((x) => x.pressed)).toEqual([false, true, false]);
    expect(nightChoices(sampleLive().event.nights, { scope: 'event' }, TZ).map((x) => x.pressed)).toEqual([false, false, true]);
  });

  it('sin fechas de la fiesta, o fuera de sus noches: «Esta noche»', () => {
    expect(nightChoices([], { scope: 'night' }, TZ).map((x) => [x.label, x.pressed])).toEqual([
      ['Esta noche', true],
      ['Toda la fiesta', false],
    ]);
    const outside = nightChoices([{ day: '2027-06-23', current: false }], { scope: 'night' }, TZ);
    expect(outside.map((x) => [x.label, x.pressed])).toEqual([
      ['Noche 1', false],
      ['Esta noche', true],
      ['Toda la fiesta', false],
    ]);
    expect(dayLabel('2027-12-01', TZ)).toBe('1 dic');
  });

  it('la etiqueta de arriba: en directo con la hora, noche cerrada o fiesta terminada', () => {
    expect(liveBadge(sampleLive(), TZ)).toEqual({ text: 'En directo · 01:47', on: true });
    expect(liveBadge(sampleLive({ live: false }), TZ)).toEqual({ text: 'Noche cerrada', on: false });
    expect(liveBadge(sampleLive({ live: false, scope: 'event' }), TZ).text).toBe('Toda la fiesta');
    expect(liveBadge(sampleLive({ live: false, event: { ...sampleLive().event, ended: true } }), TZ).text).toBe('Fiesta terminada');
  });
});

describe('ventas por hora', () => {
  it('barras con su alto frente a la mayor, «k» desde 1.000 € y la de ahora abierta', () => {
    const bars = hourBars(sampleLive().hourly, TZ);
    expect(bars.map((b) => [b.hour, b.label, b.pct, b.open])).toEqual([
      ['20 h', '620 €', 20, false],
      ['21 h', '0 €', 0, false],
      ['23 h', '3,1 k', 100, false],
      ['01 h', '1,6 k', 53, true],
    ]);
    expect(bars[0]!.day).toBe('mié 23');
    expect(bars[3]!.day).toBe('jue 24');
    expect(hoursAria(bars, sampleLive().hourly)).toContain('(la de las 01 h sigue abierta)');
    expect(hoursAria([], [])).toBe('Ventas por hora: aún no hay ventas.');
  });

  it('lo negativo (solo devoluciones en esa hora) no pinta barra', () => {
    expect(hourAmountLabel(-500)).toBe('0 €');
    expect(hourBars([{ at: '2027-06-23T18:00:00.000Z', soldCents: -500, open: false }], TZ)[0]!.pct).toBe(0);
  });
});

describe('las casetas', () => {
  const rows = plain(stallRows(sampleLive(), TZ, PARTY_NOW));

  it('con su posición, cobros y último, su % del total, la parte del organizador y su estado', () => {
    expect(rows.map((r) => [r.rank, r.name, r.sold, r.share, r.barPct, r.organizer, r.status?.text ?? null])).toEqual([
      [1, 'Peña El Cántaro', '3.840,00 €', '27 %', 100, '10 %', 'Cobrando'],
      [2, 'Caseta Los del Barrio', '2.460,00 €', '17 %', 64, '10 %', 'Sin cobros · 27 min'],
      [3, 'Barra de la Comisión', '1.580,00 €', '11 %', 41, 'Barra propia', 'Cobrando'],
      [4, 'Churrería San Juan', '0,00 €', '0 %', 0, '8 %', 'Sin cobros aún'],
      [5, 'Sin caseta', '20,00 €', '0 %', 1, null, null],
    ]);
    expect(rows[0]!.meta).toBe('1102 cobros · último 01:45');
    expect(rows[1]!.status?.tone).toBe('danger');
  });

  it('fuera de la noche en curso, sin estado (no se sabe más)', () => {
    const live = sampleLive({ live: false });
    expect(stallStatus(live.stalls[0]!, live, PARTY_NOW)).toBeNull();
    const desactivada = { ...sampleLive().stalls[0]!, active: false };
    expect(stallStatus(desactivada, sampleLive(), PARTY_NOW)).toEqual({ text: 'Desactivada', tone: 'neutral' });
  });
});

describe('de dónde entra el dinero', () => {
  it('cada taquilla con su efectivo y su tarjeta (y lo de su caja si es distinto); el móvil aparte', () => {
    expect(plain(deskRows(sampleLive()))).toEqual([
      { key: 'person:u-1', name: 'Lucía', detail: 'Efectivo 6.240,00 € · tarjeta 4.180,00 € · en la caja 6.200,00 €', total: '10.420,00 €', over: true },
      { key: 'terminal:t-1', name: 'Taquilla norte', detail: 'Efectivo 2.310,00 € · tarjeta 3.120,00 €', total: '5.430,00 €', over: true },
      { key: 'phone', name: 'Desde el móvil', detail: 'Recargas de los asistentes', total: '2.600,00 €', over: false },
    ]);
    expect(deskRows(sampleLive({ cashAlertCents: 0 })).some((d) => d.over)).toBe(false);
  });
});

describe('los avisos y su acción', () => {
  it('el efectivo: ver las taquillas; la caseta parada: llamar a su responsable si hay teléfono', () => {
    const [cash, idle] = plain(alertViews(sampleLive().alerts, TZ, PARTY_NOW));
    expect(cash).toMatchObject({
      tone: 'warning',
      title: 'Lucía: 6.200,00 € en efectivo',
      text: 'Pasa de 2.000,00 €. Conviene retirar parte del efectivo.',
      action: { kind: 'desks', label: 'Ver las taquillas' },
    });
    expect(idle).toMatchObject({
      tone: 'danger',
      title: 'Caseta Los del Barrio: sin cobros desde hace 27 min',
      text: 'Su último cobro fue a las 01:20 y las demás casetas siguen cobrando.',
      action: { kind: 'call', label: 'Llamar a Asociación de vecinos', href: 'tel:611111111' },
    });
  });

  it('sin teléfono: el contacto en el texto y «Ver la caseta»', () => {
    const [idle] = alertViews(
      [{ kind: 'STALL_IDLE', stallId: 's', name: 'Churros', minutes: 20, managerName: 'Paqui', managerContact: 'paqui@churros.es' }],
      TZ,
      PARTY_NOW,
    );
    expect(idle!.action).toEqual({ kind: 'stalls', label: 'Ver la caseta' });
    expect(idle!.text).toContain('Contacto: paqui@churros.es.');
  });

  it('qué es un teléfono que se puede marcar', () => {
    expect(telHref('+34 600 11 22 33')).toBe('tel:+34600112233');
    expect(telHref('(96) 123-45-67')).toBe('tel:961234567');
    expect(telHref('paqui@churros.es')).toBeNull();
    expect(telHref('123')).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});

describe('lo demás', () => {
  it('la línea de la fiesta: fechas, casetas activas y taquillas', () => {
    expect(eventSubtitle(sampleLive(), TZ)).toBe('Del 23 jun, 20:00 al 25 jun, 06:00 · 4 casetas · 2 taquillas');
  });

  it('el aviso de N minutos: lo guardado si es una de las opciones; si no, 15', () => {
    expect(idleFromStorage('30')).toBe(30);
    expect(idleFromStorage('7')).toBe(DEFAULT_IDLE_MINUTES);
    expect(idleFromStorage(null)).toBe(15);
  });
});
