import { describe, expect, it } from 'vitest';
import type { MyDebt, MyEarning, MyNight, OperatorBalance } from './api';
import {
  dayLabel,
  earningDetail,
  groupByNight,
  heldItems,
  heldUntil,
  moneySummary,
  nightLabel,
  otherNightsUnpaid,
  paymentTimeLabel,
  serviceNightKey,
  splitDebts,
  sumNet,
  timeLabel,
  tonightBreakdown,
  tonightEarnings,
  tonightStatus,
  unlistedCents,
} from './earnings-view';

// Intl separa la cifra del "€" (y del "%") con un espacio que no se parte (U+00A0).
const nb = (s: string) => s.replace(/ (€|%)/g, ' $1');

// Lunes 12 oct 2026. La noche se abre el martes 13 a las 22:00 de Madrid (20:00 UTC).
const NOW = Date.parse('2026-10-14T01:00:00Z'); // 03:00 de Madrid
const OPEN_NIGHT: MyNight = {
  from: '2026-10-13T20:00:00.000Z',
  to: null,
  nightOpen: true,
  count: 1,
  chargedCents: 12_500,
  commissionCents: 4_000,
  tipsCents: 500,
  reversedCents: 0,
  netCents: 4_500,
  unpaidCents: 4_500,
  otherUnpaidCents: 6_000,
};

function earning(o: Partial<MyEarning> & Pick<MyEarning, 'id' | 'createdAt' | 'netCents'>): MyEarning {
  return {
    paymentId: `p-${o.id}`,
    paymentAmountCents: 10_000,
    commissionBps: 4_000,
    commissionCents: o.netCents,
    tipCents: 0,
    reversedCents: 0,
    payoutId: null,
    paymentStatus: 'AUTHORIZED',
    ...o,
  };
}

const EARNINGS: MyEarning[] = [
  earning({ id: 'tonight', createdAt: '2026-10-13T22:30:00Z', netCents: 4_500, tipCents: 500, commissionCents: 4_000 }),
  // 01:10 del martes 13 en Madrid: es de la noche del lunes 12.
  earning({ id: 'late', createdAt: '2026-10-12T23:10:00Z', netCents: 3_000 }),
  earning({ id: 'early', createdAt: '2026-10-12T21:00:00Z', netCents: 2_000 }),
  earning({ id: 'paid', createdAt: '2026-10-11T22:00:00Z', netCents: 5_000, payoutId: 'po-1' }),
  // 07:30 del sábado 10 en Madrid: aún es la noche del viernes 9.
  earning({ id: 'friday', createdAt: '2026-10-10T05:30:00Z', netCents: 1_000 }),
];

function balance(o: Partial<OperatorBalance> = {}): OperatorBalance {
  return {
    pendingCents: 8_000,
    availableCents: 8_000,
    heldCents: 0,
    debtCents: 2_500,
    paidCents: 5_000,
    lifetimeGrossCents: 60_000,
    count: 5,
    ...o,
  };
}

describe('fechas en hora de Madrid', () => {
  it('día corto y hora', () => {
    expect(dayLabel('2026-10-12T12:00:00Z')).toBe('lun 12 oct');
    expect(timeLabel('2026-10-12T21:40:00Z')).toBe('23:40');
  });

  it('«Mis cobros» de la chica, también en hora de Madrid (no la del móvil) (APP-07)', () => {
    // 22:40 UTC del 12 = 00:40 del 13 en Madrid: con el móvil en otra zona salía el día cambiado.
    expect(paymentTimeLabel('2026-10-12T22:40:00Z')).toBe('13 oct, 00:40');
    expect(paymentTimeLabel('2026-01-15T20:05:00Z')).toBe('15 ene, 21:05');
  });

  it('la noche de un cobro cambia a las 08:00: las 03:00 aún son de la noche anterior', () => {
    expect(serviceNightKey('2026-10-13T01:10:00Z')).toBe('2026-10-12');
    expect(serviceNightKey('2026-10-13T06:30:00Z')).toBe('2026-10-13');
    expect(nightLabel('2026-10-12')).toBe('lun 12 oct');
  });
});

describe('las cifras de arriba', () => {
  it('esta noche, otras noches, deudas y el próximo pago (con el reparto del API)', () => {
    const s = moneySummary(OPEN_NIGHT, balance());
    expect(s).toEqual({
      tonightCents: 4_500,
      tonightUnpaidCents: 4_500,
      tonightPaid: false,
      otherNightsCents: 6_000,
      heldCents: 0,
      debtCents: 2_500,
      nextPayoutCents: 8_000,
      owedAfterCents: 0,
    });
  });

  it('API antiguo sin el reparto: otras noches = lo pendiente (con la deuda sumada) menos esta noche', () => {
    const { unpaidCents: _u, otherUnpaidCents: _o, ...old } = OPEN_NIGHT;
    const s = moneySummary(old, balance());
    expect(s.tonightUnpaidCents).toBe(4_500);
    expect(s.otherNightsCents).toBe(6_000); // 8.000 + 2.500 − 4.500
  });

  it('debe más de lo que tiene: el próximo pago es 0 y queda deuda para después', () => {
    const s = moneySummary(OPEN_NIGHT, balance({ pendingCents: -1_000, availableCents: -1_000, debtCents: 3_000 }));
    expect(s.nextPayoutCents).toBe(0);
    expect(s.owedAfterCents).toBe(1_000);
  });

  it('sin saldo aún cargado: el próximo pago no se sabe', () => {
    expect(moneySummary(OPEN_NIGHT, null).nextPayoutCents).toBeNull();
  });

  it('noche cerrada y ya pagada', () => {
    const closed: MyNight = { ...OPEN_NIGHT, nightOpen: false, to: '2026-10-14T04:12:00.000Z', unpaidCents: 0 };
    const s = moneySummary(closed, balance());
    expect(s.tonightPaid).toBe(true);
    expect(tonightStatus(closed, s, 0, NOW)).toEqual({
      state: 'Noche cerrada a las 06:12',
      when: 'Ya te lo han pagado',
      tone: 'paid',
    });
  });
});

describe('cuándo se lo pagan', () => {
  it('se paga cada noche: «al cerrar la noche»', () => {
    const s = moneySummary(OPEN_NIGHT, balance());
    expect(tonightStatus(OPEN_NIGHT, s, 0, NOW)).toEqual({
      state: 'Noche abierta · desde las 22:00',
      when: 'Te lo pagan al cerrar la noche',
      tone: 'open',
    });
  });

  it('con días de espera: a partir de qué día', () => {
    const s = moneySummary(OPEN_NIGHT, balance({ heldCents: 4_500 }));
    expect(tonightStatus(OPEN_NIGHT, s, 7, NOW).when).toBe('Te lo pagan a partir del mié 21 oct');
  });

  it('noche cerrada sin pagarle: pendiente de pago', () => {
    const closed: MyNight = { ...OPEN_NIGHT, nightOpen: false, to: '2026-10-14T04:12:00.000Z' };
    const s = moneySummary(closed, balance());
    expect(tonightStatus(closed, s, 0, NOW)).toMatchObject({ when: 'Pendiente de pago', tone: 'closed' });
  });

  it('sin saber los días de espera pero con algo en espera: sin fecha inventada', () => {
    const s = moneySummary(OPEN_NIGHT, balance({ heldCents: 1_000 }));
    expect(tonightStatus(OPEN_NIGHT, s, null, NOW).when).toBe('Te lo pagan cuando pasen los días de espera');
  });

  it('el local no abre la noche: desde las 08:00', () => {
    const none: MyNight = { ...OPEN_NIGHT, nightOpen: false, to: null, from: '2026-10-13T06:00:00.000Z' };
    expect(tonightStatus(none, moneySummary(none, balance()), 0, NOW)).toMatchObject({
      state: 'Sin noche abierta · desde las 08:00',
      tone: 'none',
    });
  });
});

describe('textos con su signo', () => {
  it('resumen de la noche: propinas con +, devoluciones con −', () => {
    expect(tonightBreakdown({ count: 1, tipsCents: 0, reversedCents: 0 })).toBe('1 cobro');
    expect(tonightBreakdown({ count: 3, tipsCents: 2_000, reversedCents: 1_250 })).toBe(
      nb('3 cobros · +20 € de propinas · −12,50 € por devoluciones'),
    );
  });

  it('un cobro: comisión de cuánto, su propina y su devolución', () => {
    const e = earning({
      id: 'x',
      createdAt: '2026-10-13T22:30:00Z',
      paymentAmountCents: 12_000,
      commissionBps: 3_750,
      tipCents: 500,
      reversedCents: 1_200,
      netCents: 3_800,
    });
    expect(earningDetail(e)).toBe(nb('37,5 % de 120 € · +5 € propina · devolución −12 €'));
    expect(earningDetail({ ...e, paymentId: null, tipCents: 0, reversedCents: 0 })).toBe(nb('37,5 % de 120 € del saldo'));
  });
});

describe('las listas del detalle', () => {
  it('esta noche: solo los cobros desde que se abrió', () => {
    expect(tonightEarnings(EARNINGS, OPEN_NIGHT).map((e) => e.id)).toEqual(['tonight']);
    expect(tonightEarnings(EARNINGS, null)).toEqual([]);
  });

  it('pendiente de otras noches: sin pagar, fuera de esta noche, por noches', () => {
    const other = otherNightsUnpaid(EARNINGS, OPEN_NIGHT);
    expect(other.map((e) => e.id)).toEqual(['late', 'early', 'friday']);
    const groups = groupByNight(other);
    expect(groups.map((g) => [g.label, g.totalCents, g.earnings.map((e) => e.id)])).toEqual([
      ['lun 12 oct', 5_000, ['late', 'early']],
      ['vie 9 oct', 1_000, ['friday']],
    ]);
    expect(sumNet(other)).toBe(6_000);
  });

  it('lo que el total dice y la lista no trae (cobros más antiguos)', () => {
    expect(unlistedCents(9_000, 6_000)).toBe(3_000);
    expect(unlistedCents(6_000, 6_500)).toBe(0);
  });

  it('en espera: hasta qué día cada uno, del primero que sale al último', () => {
    const items = heldItems(EARNINGS, 2, NOW);
    expect(items.map((i) => [i.earning.id, i.releaseAt])).toEqual([
      ['early', '2026-10-14T21:00:00.000Z'],
      ['late', '2026-10-14T23:10:00.000Z'],
      ['tonight', '2026-10-15T22:30:00.000Z'],
    ]);
    expect(heldUntil(items)).toBe('2026-10-15T22:30:00.000Z');
    expect(heldItems(EARNINGS, 0, NOW)).toEqual([]);
    expect(heldUntil([])).toBeNull();
  });

  it('deudas: las que se van a descontar y las ya descontadas', () => {
    const debt = (id: string, settledPayoutId: string | null): MyDebt => ({
      id,
      paymentId: 'p',
      chargeCents: 10_000,
      cents: 3_000,
      at: '2026-10-13T10:00:00Z',
      chargedAt: '2026-10-11T22:00:00Z',
      settledPayoutId,
      settledAt: settledPayoutId ? '2026-10-13T05:00:00Z' : null,
    });
    const { open, settled } = splitDebts([debt('a', null), debt('b', 'po-2')]);
    expect(open.map((d) => d.id)).toEqual(['a']);
    expect(settled.map((d) => d.id)).toEqual(['b']);
  });
});
