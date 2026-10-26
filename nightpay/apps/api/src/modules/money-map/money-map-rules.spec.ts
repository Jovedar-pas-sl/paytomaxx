import { describe, it, expect } from 'vitest';
import { MONEY_MAP_TIPS, venueSharePercent } from '@nightpay/contracts';
import {
  buildMoneyMap,
  frozenMoneyMapOf,
  platformCommissionCents,
  saleMethodOf,
  saleSections,
  sectionCodeOf,
  sectionsOf,
  type MoneyMapInput,
  type SaleRow,
} from './money-map-rules';

const T = (iso: string) => new Date(iso);

const sale = (o: Partial<SaleRow>): SaleRow => ({
  amountCents: 0,
  tipCents: 0,
  category: 'VENUE_BAR',
  method: 'CARD',
  platformBps: 0,
  lines: [],
  ...o,
});

/** Una noche como la de la maqueta, pequeña: tarjeta, Apple Pay, datáfono y saldo. */
function input(o: Partial<MoneyMapInput> = {}): MoneyMapInput {
  return {
    scope: { kind: 'night', nightId: 'n1', open: true },
    window: { from: T('2026-10-24T20:00:00Z'), to: T('2026-10-25T02:00:00Z') },
    now: T('2026-10-25T02:00:00Z'),
    frozen: false,
    sales: [
      // Pack de la chica con tarjeta: Servicios 120 + Habitaciones 30, propina 5.
      sale({
        amountCents: 15_000,
        tipCents: 500,
        category: 'CHICA_SERVICE',
        method: 'CARD',
        platformBps: 1000,
        lines: [
          { category: 'CHICA_SERVICE', amountCents: 12_000 },
          { category: 'VENUE_ROOM', amountCents: 3_000 },
        ],
      }),
      // Dos copas con Apple Pay.
      sale({ amountCents: 2_000, method: 'MOBILE_WALLET', platformBps: 1000, lines: [{ category: 'VENUE_BAR', amountCents: 2_000 }] }),
      // Entrada en el datáfono, de antes de las líneas.
      sale({ amountCents: 1_500, category: 'VENUE_ENTRY', method: 'POS', platformBps: 1000 }),
      // Del saldo: 1 h con Lola.
      sale({ amountCents: 12_000, category: 'CHICA_SERVICE', method: 'SALDO', platformBps: 1000, lines: [{ category: 'CHICA_SERVICE', amountCents: 12_000 }] }),
    ],
    topUps: { cardCents: 20_000, cardCount: 1, cashCents: 10_000, cashCount: 1 },
    staff: { chicas: { grossCents: 22_100, unpaidCents: 22_100 }, camareros: { grossCents: 500, unpaidCents: 500 } },
    cardRefunds: { cents: 1_000, count: 1 },
    walletPayouts: { cashCents: 2_000, cashCount: 1, cardCents: 0 },
    payouts: [],
    cashBox: { openingFloatCents: 5_000, inCents: 10_000, outCents: 2_000, expectedCents: 13_000 },
    bankFeeBps: null,
    liveSaldoCents: 16_000,
    owed: { chicasCents: 30_000, camarerosCents: 500 },
    ...o,
  };
}

describe('mapa del dinero: los carriles cuadran', () => {
  it('lo que entra por canal = lo vendido por sección = lo repartido', () => {
    const m = buildMoneyMap(input());
    expect(m.salesCents).toBe(31_000);
    expect(m.inflow).toMatchObject({ cardCents: 15_500, mobileWalletCents: 2_000, posCents: 1_500, cardRailCents: 19_000, cashCents: 0, saldoCents: 12_000 });
    expect(m.inflow.cardRailCents + m.inflow.cashCents + m.inflow.saldoCents).toBe(m.salesCents);
    const bySection = Object.fromEntries(m.sections.map((s) => [s.code, s.amountCents]));
    expect(bySection).toEqual({
      CHICA_SERVICE: 24_000,
      VENUE_BAR: 2_000,
      VENUE_ROOM: 3_000,
      VENUE_FOOD: 0,
      VENUE_ENTRY: 1_500,
      [MONEY_MAP_TIPS]: 500,
    });
    expect(m.sections.reduce((a, s) => a + s.amountCents, 0)).toBe(m.salesCents);
    const s = m.split;
    expect(s.venueCents + s.chicasCents + s.camarerosCents + s.commissions.totalCents).toBe(m.salesCents);
  });

  it('las recargas van aparte: no son venta', () => {
    const m = buildMoneyMap(input());
    expect(m.inflow.topUps).toEqual({ totalCents: 30_000, cardCents: 20_000, cashCents: 10_000, count: 2 });
    expect(m.salesCents).toBe(31_000);
  });

  it('OxioPay: su % sobre lo vendido sin propinas; el banco, sin tasa, no se calcula', () => {
    const m = buildMoneyMap(input());
    // 10 % de 150 + 20 + 15 + 120 €.
    expect(m.split.commissions).toEqual({ platformCents: 3_050, bankCents: null, totalCents: 3_050 });
    expect(m.split.venueCents).toBe(31_000 - 22_100 - 500 - 3_050);
    expect(m.outflow.commissionsCents).toBe(3_050);
  });

  it('con la tasa del banco: sobre todo lo que pasa por él (ventas con tarjeta y recargas)', () => {
    const m = buildMoneyMap(input({ bankFeeBps: 50 }));
    // 0,5 % de (190 + 200) €.
    expect(m.split.commissions).toEqual({ platformCents: 3_050, bankCents: 195, totalCents: 3_245 });
  });

  it('dónde está: BBVA (lo cobrado con tarjeta − lo devuelto) + caja = lo de cada dueño', () => {
    const m = buildMoneyMap(input());
    expect(m.where.bbvaCents).toBe(19_000 + 20_000 - 1_000);
    expect(m.where.cashBoxCents).toBe(13_000);
    expect(m.where.totalCents).toBe(51_000);
    const o = m.where.owners;
    // Saldo vivo que dejó la noche: 300 € de recargas − 120 gastados − 20 devueltos.
    expect(o.saldoCents).toBe(16_000);
    expect(o.staffCents).toBe(22_600);
    expect(o.venueCents + o.staffCents + o.saldoCents).toBe(m.where.totalCents);
    expect(m.where.liveSaldoCents).toBe(16_000);
    expect(m.where.owed).toEqual({ chicasCents: 30_000, camarerosCents: 500 });
  });

  it('qué sale: pagos al personal (de más a menos), lo pendiente, devoluciones y comisiones', () => {
    const m = buildMoneyMap(
      input({
        payouts: [
          { who: 'camareros', rail: 'MANUAL_CASH', count: 1, cents: 500 },
          { who: 'chicas', rail: 'BANK_WIRE', count: 2, cents: 9_000 },
        ],
      }),
    );
    expect(m.outflow.payouts.map((p) => p.cents)).toEqual([9_000, 500]);
    expect(m.outflow.pendingStaff).toEqual({ chicasCents: 22_100, camarerosCents: 500 });
    expect(m.outflow.refunds).toEqual({ cardCents: 1_000, cardCount: 1, cashCents: 2_000, cashCount: 1 });
  });

  it('una noche vacía: todo a cero y las secciones siguen ahí (sin «Otros»)', () => {
    const m = buildMoneyMap(
      input({
        sales: [],
        topUps: { cardCents: 0, cardCount: 0, cashCents: 0, cashCount: 0 },
        staff: { chicas: { grossCents: 0, unpaidCents: 0 }, camareros: { grossCents: 0, unpaidCents: 0 } },
        cardRefunds: { cents: 0, count: 0 },
        walletPayouts: { cashCents: 0, cashCount: 0, cardCents: 0 },
        cashBox: { openingFloatCents: null, inCents: 0, outCents: 0, expectedCents: 0 },
      }),
    );
    expect(m.salesCents).toBe(0);
    expect(m.sections.map((s) => s.code)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', MONEY_MAP_TIPS]);
    expect(venueSharePercent(m)).toBe(0);
    expect(m.where.owners).toEqual({ venueCents: 0, staffCents: 0, saldoCents: 0, oxioPayCents: 0 });
  });
});

describe('secciones de un cobro', () => {
  it('sus líneas; si no suman su importe, lo que falta en su sección principal', () => {
    const s = saleSections(sale({ amountCents: 5_000, category: 'VENUE_BAR', lines: [{ category: 'VENUE_ROOM', amountCents: 3_000 }] }));
    expect([...s]).toEqual([
      ['VENUE_ROOM', 3_000],
      ['VENUE_BAR', 2_000],
    ]);
  });

  it('cobro antiguo sin líneas: su categoría; «Otros» (EXTRA) o una desconocida, en «Otros»', () => {
    expect([...saleSections(sale({ amountCents: 900, category: 'VENUE_FOOD' }))]).toEqual([['VENUE_FOOD', 900]]);
    expect([...saleSections(sale({ amountCents: 900, category: 'bar' }))]).toEqual([['EXTRA', 900]]);
    expect(sectionCodeOf(null)).toBe('EXTRA');
    const rows = sectionsOf([sale({ amountCents: 900, category: 'EXTRA', tipCents: 100 })]);
    expect(rows.map((r) => r.code)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA', MONEY_MAP_TIPS]);
    expect(rows.find((r) => r.code === 'EXTRA')).toEqual({ code: 'EXTRA', amountCents: 900, count: 1 });
    expect(rows.find((r) => r.code === MONEY_MAP_TIPS)).toEqual({ code: MONEY_MAP_TIPS, amountCents: 100, count: 1 });
  });

  it('cuenta cuántos cobros tienen algo en cada sección (un pack cuenta en las dos)', () => {
    const rows = sectionsOf(input().sales);
    expect(rows.find((r) => r.code === 'CHICA_SERVICE')?.count).toBe(2);
    expect(rows.find((r) => r.code === 'VENUE_ROOM')?.count).toBe(1);
  });

  it('la comisión de OxioPay redondea cobro a cobro', () => {
    expect(platformCommissionCents([sale({ amountCents: 1_005, platformBps: 1000 }), sale({ amountCents: 1_005, platformBps: 1000 })])).toBe(202);
  });
});

describe('cómo pagó', () => {
  it('datáfono, Apple Pay / Google Pay, tarjeta o efectivo', () => {
    expect(saleMethodOf({ captureMethod: 'POS_EXTERNAL', posOperationNumber: null, approvedPayMethod: null })).toBe('POS');
    expect(saleMethodOf({ captureMethod: 'QR', posOperationNumber: '77', approvedPayMethod: null })).toBe('POS');
    expect(saleMethodOf({ captureMethod: 'QR', posOperationNumber: null, approvedPayMethod: 'wallet' })).toBe('MOBILE_WALLET');
    expect(saleMethodOf({ captureMethod: null, posOperationNumber: null, approvedPayMethod: 'card' })).toBe('CARD');
    expect(saleMethodOf({ captureMethod: 'CASH', posOperationNumber: null, approvedPayMethod: null })).toBe('CASH');
  });
});

describe('el mapa congelado en el Z', () => {
  it('se lee del Z (y dice que está congelado); los Z de antes no lo traen', () => {
    const m = buildMoneyMap(input());
    expect(frozenMoneyMapOf({ summary: {}, moneyMap: m })).toEqual({ ...m, frozen: true });
    expect(frozenMoneyMapOf({ summary: {} })).toBeNull();
    expect(frozenMoneyMapOf(null)).toBeNull();
    expect(frozenMoneyMapOf({ moneyMap: { nope: 1 } })).toBeNull();
  });

  it('el % del local para el anillo, entre 0 y 100', () => {
    expect(venueSharePercent({ salesCents: 10_000, split: { venueCents: 5_840 } as never })).toBe(58);
    expect(venueSharePercent({ salesCents: 10_000, split: { venueCents: -100 } as never })).toBe(0);
  });
});

describe('con la «Comisión del servicio» (la paga el cliente, se debe a OxioPay)', () => {
  // 33 € con tarjeta + 3,30 € de comisión + 2 € de propina (sin el % antiguo);
  // 20 € del saldo (sin comisión ni % antiguo); recarga con tarjeta 50 € + 6 €
  // y en efectivo 50 € + 6 €; se devuelven 19,15 € del pago (1,65 € de comisión).
  const feeInput = () =>
    input({
      sales: [
        sale({ amountCents: 3_300, tipCents: 200, serviceFeeCents: 330, category: 'CHICA_SERVICE', method: 'CARD', platformBps: 0 }),
        sale({ amountCents: 2_000, method: 'SALDO', platformBps: 0 }),
      ],
      topUps: { cardCents: 5_000, cardCount: 1, cashCents: 5_000, cashCount: 1, cardFeeCents: 600, cashFeeCents: 600 },
      staff: { chicas: { grossCents: 3_170, unpaidCents: 3_170 }, camareros: { grossCents: 0, unpaidCents: 0 } },
      cardRefunds: { cents: 1_915, count: 1, serviceFeeCents: 165 },
      walletPayouts: { cashCents: 0, cashCount: 0, cardCents: 0 },
      cashBox: { openingFloatCents: 0, inCents: 5_600, outCents: 0, expectedCents: 5_600 },
    });

  it('la comisión va aparte de lo vendido; el local ya no paga el % antiguo en esas ventas', () => {
    const m = buildMoneyMap(feeInput());
    expect(m.salesCents).toBe(3_300 + 200 + 2_000);
    expect(m.split.commissions.platformCents).toBe(0);
    expect(m.serviceFee).toEqual({ salesCents: 330, topUpsCents: 1_200, cashCents: 600, refundedCents: 165, owedCents: 1_365 });
    expect(m.inflow.serviceFeeCents).toBe(1_530);
    // Lo repartido sigue sumando lo vendido (la comisión no es venta del local).
    const s = m.split;
    expect(s.venueCents + s.chicasCents + s.camarerosCents + s.commissions.totalCents).toBe(m.salesCents);
  });

  it('el dinero entra entero (BBVA y caja) y se apunta lo de OxioPay: todo cuadra', () => {
    const m = buildMoneyMap(feeInput());
    // BBVA: 35 € de la venta + 3,30 € + 50 € + 6 € de la recarga − 19,15 € devueltos.
    expect(m.where.bbvaCents).toBe(3_500 + 330 + 5_000 + 600 - 1_915);
    expect(m.where.cashBoxCents).toBe(5_600);
    const o = m.where.owners;
    expect(o.oxioPayCents).toBe(1_365);
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0)).toBe(m.where.totalCents);
    expect(m.outflow.serviceFeeCents).toBe(1_365);
  });

  it('el banco cobra su tasa también sobre la comisión que pasa por él', () => {
    const m = buildMoneyMap({ ...feeInput(), bankFeeBps: 100 });
    // 1 % de (35 + 3,30 + 50 + 6) €.
    expect(m.split.commissions.bankCents).toBe(Math.round((3_500 + 330 + 5_000 + 600) / 100));
  });

  it('sin comisión, como siempre (todo a cero y nada se le resta al local)', () => {
    const m = buildMoneyMap(input());
    expect(m.serviceFee).toEqual({ salesCents: 0, topUpsCents: 0, cashCents: 0, refundedCents: 0, owedCents: 0 });
    expect(m.where.owners.oxioPayCents).toBe(0);
  });
});
