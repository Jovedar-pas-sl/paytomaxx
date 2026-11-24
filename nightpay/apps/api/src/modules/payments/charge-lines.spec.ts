import { describe, it, expect } from 'vitest';
import {
  fallbackSection,
  lineCommission,
  lineViews,
  primaryCategory,
  requestedItemIds,
  resolveChargeLines,
  type CartaItemLike,
} from './charge-lines';
import { resolveBpsForOperator } from './commission';

const COPA: CartaItemLike = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Copa',
  priceCents: 1000,
  durationMin: null,
  category: 'VENUE_BAR',
  active: true,
  components: null,
};
const HORA_HAB: CartaItemLike = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '1 h con habitación',
  priceCents: 15000,
  durationMin: 60,
  category: 'CHICA_SERVICE',
  active: true,
  components: [
    { category: 'CHICA_SERVICE', amountCents: 12000 },
    { category: 'VENUE_ROOM', amountCents: 3000 },
  ],
};
const MEDIA_HORA: CartaItemLike = {
  id: '33333333-3333-4333-8333-333333333333',
  name: '30 min',
  priceCents: 10000,
  durationMin: 30,
  category: 'CHICA_SERVICE',
  active: true,
  components: null,
};
const items = new Map([COPA, HORA_HAB, MEDIA_HORA].map((i) => [i.id, i]));

function resolved(req: Parameters<typeof resolveChargeLines>[0]) {
  const r = resolveChargeLines(req);
  if (!r.ok) throw new Error(`esperaba ok, llegó ${r.reason}`);
  return r.charge;
}

describe('sección de un cobro sin carta: nunca «Otros»', () => {
  it('orden: la pedida → la del puesto → la del rol', () => {
    expect(fallbackSection({ requestedCategory: 'VENUE_FOOD', puesto: 'BARRA', role: 'WAITER' })).toBe('VENUE_FOOD');
    expect(fallbackSection({ requestedCategory: null, puesto: 'RECEPCION', role: 'WAITER' })).toBe('VENUE_ENTRY');
    expect(fallbackSection({ requestedCategory: null, puesto: 'HABITACIONES', role: 'WAITER' })).toBe('VENUE_ROOM');
    expect(fallbackSection({ requestedCategory: null, puesto: null, role: 'OPERATOR' })).toBe('CHICA_SERVICE');
    expect(fallbackSection({ requestedCategory: null, puesto: null, role: 'WAITER' })).toBe('VENUE_BAR');
    expect(fallbackSection({ requestedCategory: null, puesto: null, role: 'OWNER' })).toBe('VENUE_BAR');
  });

  it('EXTRA (apps antiguas, «Otro») o algo raro no cuentan: cae en el puesto o el rol', () => {
    expect(fallbackSection({ requestedCategory: 'EXTRA', puesto: 'COCINA', role: 'WAITER' })).toBe('VENUE_FOOD');
    expect(fallbackSection({ requestedCategory: 'EXTRA', puesto: null, role: 'WAITER' })).toBe('VENUE_BAR');
    expect(fallbackSection({ requestedCategory: 'INVENTADA', puesto: 'NO-ES-PUESTO', role: 'OPERATOR' })).toBe('CHICA_SERVICE');
  });
});

describe('resolveChargeLines — peticiones antiguas (una línea)', () => {
  it('importe suelto de la chica → una línea de Servicios', () => {
    const c = resolved({ amountCents: 5000, role: 'OPERATOR', items });
    expect(c.lines).toEqual([
      { category: 'CHICA_SERVICE', serviceItemId: null, label: 'Otro importe', qty: 1, unitCents: 5000, amountCents: 5000 },
    ]);
    expect(c).toMatchObject({ amountCents: 5000, primaryCategory: 'CHICA_SERVICE', service: null, serviceName: null, typedCents: 5000 });
  });

  it('importe del camarero con su sección (o EXTRA → su puesto)', () => {
    expect(resolved({ amountCents: 2000, requestedCategory: 'VENUE_FOOD', role: 'WAITER', items }).primaryCategory).toBe('VENUE_FOOD');
    expect(resolved({ amountCents: 2000, requestedCategory: 'EXTRA', puesto: 'RECEPCION', role: 'WAITER', items }).primaryCategory).toBe(
      'VENUE_ENTRY',
    );
  });

  it('servicio de la carta: su precio y su sección, como antes (el importe pedido se ignora)', () => {
    const c = resolved({ serviceItemId: MEDIA_HORA.id, amountCents: 1, role: 'OPERATOR', items });
    expect(c.amountCents).toBe(10000);
    expect(c.service).toEqual({ serviceItemId: MEDIA_HORA.id, serviceName: '30 min', durationMin: 30 });
    expect(c.serviceName).toBe('30 min');
    expect(c.typedCents).toBe(0);
    expect(c.lines).toHaveLength(1);
  });

  it('un servicio antiguo en «Otros» cae en la sección de quien cobra', () => {
    const viejo = { ...COPA, id: '44444444-4444-4444-8444-444444444444', category: 'EXTRA' };
    const c = resolved({ serviceItemId: viejo.id, puesto: 'BARRA', role: 'WAITER', items: new Map([[viejo.id, viejo]]) });
    expect(c.lines[0]!.category).toBe('VENUE_BAR');
  });

  it('servicio que no es de la carta, desactivado o sin nada que cobrar', () => {
    expect(resolveChargeLines({ serviceItemId: '99999999-9999-4999-8999-999999999999', items })).toEqual({ ok: false, reason: 'item-missing' });
    const off = { ...COPA, active: false };
    expect(resolveChargeLines({ serviceItemId: COPA.id, items: new Map([[COPA.id, off]]) })).toEqual({ ok: false, reason: 'item-inactive' });
    expect(resolveChargeLines({ items })).toEqual({ ok: false, reason: 'no-amount' });
    expect(resolveChargeLines({ amountCents: 0, items })).toEqual({ ok: false, reason: 'no-amount' });
  });
});

describe('packs: una línea por parte', () => {
  it('«1 h con habitación» 150 € = Servicios 120 € + Habitaciones 30 €', () => {
    const c = resolved({ serviceItemId: HORA_HAB.id, role: 'OPERATOR', items });
    expect(c.lines.map((l) => [l.category, l.amountCents, l.label])).toEqual([
      ['CHICA_SERVICE', 12000, '1 h con habitación'],
      ['VENUE_ROOM', 3000, '1 h con habitación'],
    ]);
    expect(c.amountCents).toBe(15000);
    expect(c.primaryCategory).toBe('CHICA_SERVICE');
    expect(c.service).toEqual({ serviceItemId: HORA_HAB.id, serviceName: '1 h con habitación', durationMin: 60 });
  });

  it('dos packs: cada parte por 2', () => {
    const c = resolved({ lines: [{ serviceItemId: HORA_HAB.id, qty: 2 }], items });
    expect(c.lines.map((l) => [l.qty, l.unitCents, l.amountCents])).toEqual([
      [2, 12000, 24000],
      [2, 3000, 6000],
    ]);
    expect(c.amountCents).toBe(30000);
    expect(c.service).toBeNull();
    expect(c.serviceName).toBe('2× 1 h con habitación');
  });

  it('un pack que ya no suma su precio (lo cambió alguien en la base) se cobra entero en su sección', () => {
    const roto = { ...HORA_HAB, priceCents: 16000 };
    const c = resolved({ serviceItemId: roto.id, items: new Map([[roto.id, roto]]) });
    expect(c.lines).toEqual([
      { category: 'CHICA_SERVICE', serviceItemId: roto.id, label: '1 h con habitación', qty: 1, unitCents: 16000, amountCents: 16000 },
    ]);
  });
});

describe('líneas explícitas (varias cosas en un cobro)', () => {
  it('2 copas y una habitación tecleada: cada una a su sección y el total lo calcula el servidor', () => {
    const c = resolved({
      lines: [
        { serviceItemId: COPA.id, qty: 2 },
        { category: 'VENUE_ROOM', amountCents: 3000, label: 'Habitación 4' },
      ],
      amountCents: 1, // se ignora
      requestedCategory: 'CHICA_SERVICE', // se ignora
      role: 'WAITER',
      items,
    });
    expect(c.lines.map((l) => [l.category, l.qty, l.amountCents, l.label])).toEqual([
      ['VENUE_BAR', 2, 2000, 'Copa'],
      ['VENUE_ROOM', 1, 3000, 'Habitación 4'],
    ]);
    expect(c.amountCents).toBe(5000);
    expect(c.primaryCategory).toBe('VENUE_ROOM');
    expect(c.serviceName).toBe('2× Copa · Habitación 4');
    // Para el tope de «Otro importe» cuenta solo lo tecleado, no las copas de la carta.
    expect(c.typedCents).toBe(3000);
  });

  it('a igualdad de importe manda la primera sección', () => {
    expect(primaryCategory([{ category: 'VENUE_BAR', amountCents: 10 }, { category: 'VENUE_FOOD', amountCents: 10 }])).toBe('VENUE_BAR');
  });

  it('el total no pasa de 10.000 €', () => {
    expect(
      resolveChargeLines({ lines: [{ category: 'VENUE_BAR', amountCents: 900_000 }, { category: 'VENUE_FOOD', amountCents: 200_000 }], items }),
    ).toEqual({ ok: false, reason: 'too-much' });
  });

  it('el resumen largo se corta con «…»', () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ category: 'VENUE_BAR' as const, amountCents: 100, label: `Botella número ${i}` }));
    const c = resolved({ lines, items });
    expect(c.serviceName!.length).toBeLessThanOrEqual(120);
    expect(c.serviceName!.endsWith('…')).toBe(true);
  });

  it('los servicios que hay que leer de la carta (sin repetir)', () => {
    expect(requestedItemIds({ lines: [{ serviceItemId: COPA.id, qty: 1 }, { serviceItemId: COPA.id, qty: 2 }, { category: 'VENUE_BAR', amountCents: 5 }] })).toEqual([
      COPA.id,
    ]);
    expect(requestedItemIds({ serviceItemId: MEDIA_HORA.id })).toEqual([MEDIA_HORA.id]);
    // Con líneas, el serviceItemId suelto no cuenta.
    expect(requestedItemIds({ lines: [{ category: 'VENUE_BAR', amountCents: 5 }], serviceItemId: MEDIA_HORA.id })).toEqual([]);
  });

  it('vista de las líneas para las apps', () => {
    const c = resolved({ serviceItemId: HORA_HAB.id, items });
    expect(lineViews(c.lines)[1]).toEqual({
      category: 'VENUE_ROOM',
      label: '1 h con habitación',
      qty: 1,
      unitCents: 3000,
      amountCents: 3000,
      serviceItemId: HORA_HAB.id,
    });
  });
});

describe('comisión de la chica por línea', () => {
  it('pack: su % solo sobre la parte de Servicios', () => {
    const c = lineCommission([
      { amountCents: 12000, bps: 9000 },
      { amountCents: 3000, bps: 0 },
    ]);
    expect(c).toEqual({ commissionCents: 10800, commissionBps: 7200, anyBps: true });
  });

  it('todo del local al 0 %: sin comisión (y sin ganancia, salvo propina)', () => {
    expect(lineCommission([{ amountCents: 2000, bps: 0 }])).toEqual({ commissionCents: 0, commissionBps: 0, anyBps: false });
  });

  it('REGRESIÓN: un cobro de una sola sección da exactamente lo de siempre', () => {
    // Antes: commissionCents = round(importe × % / 10000) y commissionBps = el %.
    for (const amount of [1, 3, 99, 333, 1001, 4999, 10_000, 12_345, 99_999, 1_000_000]) {
      for (const bps of [0, 1, 333, 1500, 6666, 9000, 10_000]) {
        const before = Math.round((amount * bps) / 10_000);
        // En una línea…
        expect(lineCommission([{ amountCents: amount, bps }])).toEqual({ commissionCents: before, commissionBps: bps, anyBps: bps > 0 });
        // …y en varias de la misma sección (2 copas en dos líneas): agrupa antes de redondear.
        const split = [
          { amountCents: Math.floor(amount / 2), bps },
          { amountCents: amount - Math.floor(amount / 2), bps },
        ];
        expect(lineCommission(split).commissionCents).toBe(before);
        expect(lineCommission(split).commissionBps).toBe(bps);
      }
    }
  });

  it('REGRESIÓN: con el % de cada sección como hoy (override de la chica solo en Servicios)', () => {
    const venueMap = { CHICA_SERVICE: 8500, VENUE_BAR: 500, VENUE_ROOM: 0, VENUE_FOOD: 0, EXTRA: 0 };
    const bps = (category: string) => resolveBpsForOperator({ category, userCommissionBpsOverride: 9000, venueMap });
    // Servicios: el suyo (90 %); barra: el del local (5 %); Entradas, sin guardar en locales antiguos: 0.
    expect(lineCommission([{ amountCents: 10_000, bps: bps('CHICA_SERVICE') }]).commissionCents).toBe(9000);
    expect(lineCommission([{ amountCents: 10_000, bps: bps('VENUE_BAR') }]).commissionCents).toBe(500);
    expect(bps('VENUE_ENTRY')).toBe(0);
  });

  it('sin líneas (importe 0) no divide por cero', () => {
    expect(lineCommission([])).toEqual({ commissionCents: 0, commissionBps: 0, anyBps: false });
  });
});
