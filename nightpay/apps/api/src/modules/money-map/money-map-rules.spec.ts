import { describe, it, expect } from 'vitest';
import { MONEY_MAP_TIPS, venueEarnedCents, venueSharePercent } from '@nightpay/contracts';
import {
  buildMoneyMap,
  frozenMoneyMapOf,
  oxioPayCentsOf,
  oxioPayOwedOf,
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
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(m.where.totalCents);
    expect(m.where.liveSaldoCents).toBe(16_000);
    expect(m.where.owed).toEqual({ chicasCents: 30_000, camarerosCents: 500 });
  });

  it('de lo devuelto, lo que era venta y sin la comisión del servicio va aparte («ganado» lo resta en el panel); los mapas de antes no lo traen', () => {
    expect(buildMoneyMap(input()).outflow.refunds.salesCents).toBeUndefined();
    const m = buildMoneyMap(input({ cardRefunds: { cents: 1_000, count: 1, serviceFeeCents: 100, salesNetCents: 900 } }));
    expect(m.outflow.refunds).toMatchObject({ cardCents: 1_000, cardCount: 1, salesCents: 900 });
    // Lo repartido no cambia: la resta la hace la tarjeta «¿Cuánto he ganado?».
    expect(m.split.venueCents).toBe(31_000 - 22_100 - 500 - 3_050);
  });

  it('«¿Cuánto he ganado?» (venueEarnedCents): un cobro devuelto no se queda como ganancia', () => {
    // 100 € con tarjeta: 50 % de la compañera y 10 % de OxioPay. Sin devolver, el local gana 40 €.
    const one = (o: Partial<MoneyMapInput>) =>
      buildMoneyMap(
        input({
          sales: [sale({ amountCents: 10_000, category: 'CHICA_SERVICE', platformBps: 1000 })],
          staff: { chicas: { grossCents: 5_000, unpaidCents: 5_000 }, camareros: { grossCents: 0, unpaidCents: 0 } },
          cardRefunds: { cents: 0, count: 0, salesNetCents: 0 },
          ...o,
        }),
      );
    expect(venueEarnedCents(one({}))).toBe(4_000);
    // Devuelto entero esa misma noche: el cobro sigue contando como venta y a ella se le quita su parte.
    // El reparto daría 90 € para el local; lo ganado de verdad es −10 € (el % de OxioPay se mantiene).
    const sameNight = one({ staff: { chicas: { grossCents: 0, unpaidCents: 0 }, camareros: { grossCents: 0, unpaidCents: 0 } }, cardRefunds: { cents: 10_000, count: 1, salesNetCents: 10_000 } });
    expect(sameNight.split.venueCents).toBe(9_000);
    expect(venueEarnedCents(sameNight)).toBe(-1_000);
    // Hoy sin ventas, y se devuelve un cobro de otra noche: el reparto daría +50 €; lo ganado, −50 €.
    const otherNight = one({ sales: [], staff: { chicas: { grossCents: -5_000, unpaidCents: -5_000 }, camareros: { grossCents: 0, unpaidCents: 0 } }, cardRefunds: { cents: 10_000, count: 1, salesNetCents: 10_000 } });
    expect(otherNight.split.venueCents).toBe(5_000);
    expect(venueEarnedCents(otherNight)).toBe(-5_000);
    // Una recarga devuelta no es venta: no resta de lo ganado.
    expect(venueEarnedCents(one({ cardRefunds: { cents: 5_000, count: 1, salesNetCents: 0 } }))).toBe(4_000);
    // Un mapa de antes (sin la cifra): sin restar.
    expect(venueEarnedCents(buildMoneyMap(input()))).toBe(buildMoneyMap(input()).split.venueCents);
  });

  it('la deuda de las compañeras por devoluciones tras pagarles va aparte de lo debido', () => {
    const m = buildMoneyMap(input({ owed: { chicasCents: 30_000, camarerosCents: 500, debtCents: 8_000 } }));
    expect(m.where.owed).toEqual({ chicasCents: 30_000, camarerosCents: 500, debtCents: 8_000 });
  });

  it('«Tuyo» no cuenta lo ya pagado por banco ni las comisiones: el dinero que no es del local no se puede gastar', () => {
    const noche = (rail: string, cashBox: number) =>
      buildMoneyMap(
        input({
          sales: [sale({ amountCents: 100_000, category: 'VENUE_BAR', method: rail === 'MANUAL_CASH' ? 'CASH' : 'CARD', platformBps: 1000 })],
          topUps: { cardCents: 0, cardCount: 0, cashCents: 0, cashCount: 0 },
          walletPayouts: { cashCents: 0, cashCount: 0, cardCents: 0 },
          cardRefunds: { cents: 0, count: 0 },
          staff: { chicas: { grossCents: 40_000, unpaidCents: 0 }, camareros: { grossCents: 0, unpaidCents: 0 } },
          payouts: [{ who: 'chicas', rail, count: 1, cents: 40_000 }],
          bankFeeBps: 0,
          cashBox: { openingFloatCents: 0, inCents: cashBox, outCents: 0, expectedCents: cashBox },
        }),
      );
    // 1.000 € con tarjeta, 400 € al personal por transferencia, 10 % de OxioPay: al local le quedan 500 €.
    const tarjeta = noche('BANK_TRANSFER', 0).where;
    expect(tarjeta.bbvaCents).toBe(100_000);
    expect(tarjeta.owners).toMatchObject({ paidOutCents: 40_000, commissionsCents: 10_000, venueCents: 50_000 });
    // Lo mismo en efectivo: los 400 € ya salieron de la caja, no se restan otra vez.
    const efectivo = noche('MANUAL_CASH', 60_000).where;
    expect(efectivo.owners).toMatchObject({ paidOutCents: 0, commissionsCents: 10_000, venueCents: 50_000 });
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
    expect(m.where.owners).toEqual({ venueCents: 0, staffCents: 0, saldoCents: 0, paidOutCents: 0, commissionsCents: 0 });
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

  it('OxioPay no cobra su % de lo devuelto (como «Ver detalle»): entero 0; en parte, sobre lo que queda (la propina se devuelve primero)', () => {
    // 100 € al 10 %: sin devolver, 10 €; devuelto entero, 0 €.
    expect(platformCommissionCents([sale({ amountCents: 10_000, platformBps: 1000 })])).toBe(1_000);
    expect(platformCommissionCents([sale({ amountCents: 10_000, platformBps: 1000, refundedSaleCents: 10_000 })])).toBe(0);
    // 100 € + 10 € de propina, devueltos 40 €: 10 de la propina y 30 del importe → 10 % de 70 € = 7 €.
    expect(platformCommissionCents([sale({ amountCents: 10_000, tipCents: 1_000, platformBps: 1000, refundedSaleCents: 4_000 })])).toBe(700);
    // Solo la propina devuelta: el % sigue entero.
    expect(platformCommissionCents([sale({ amountCents: 10_000, tipCents: 1_000, platformBps: 1000, refundedSaleCents: 1_000 })])).toBe(1_000);
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
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(m.where.totalCents);
    expect(m.outflow.serviceFeeCents).toBe(1_365);
  });

  it('el banco cobra su tasa también sobre la comisión que pasa por él', () => {
    const m = buildMoneyMap({ ...feeInput(), bankFeeBps: 100 });
    // 1 % de (35 + 3,30 + 50 + 6) €.
    expect(m.split.commissions.bankCents).toBe(Math.round((3_500 + 330 + 5_000 + 600) / 100));
  });

  it('sin comisión, el mapa de siempre (sin sus campos y nada se le resta al local)', () => {
    const m = buildMoneyMap(input());
    expect(m).not.toHaveProperty('serviceFee');
    expect(m.inflow).not.toHaveProperty('serviceFeeCents');
    expect(m.where.owners).not.toHaveProperty('oxioPayCents');
    expect(m.outflow).not.toHaveProperty('serviceFeeCents');
  });
});

describe('consumos del saldo: el % antiguo solo sobre lo cargado SIN comisión del servicio', () => {
  it('30 € del saldo, 10 € cargados con comisión: el 10 % de los otros 20 € (2 €)', () => {
    const m = buildMoneyMap(
      input({ sales: [sale({ amountCents: 3_000, method: 'SALDO', platformBps: 1000, serviceFeeSaldoCents: 1_000 })] }),
    );
    expect(m.split.commissions.platformCents).toBe(200);
  });

  it('todo cargado con comisión: nada; todo sin ella (o de antes): el 10 % entero', () => {
    const all = buildMoneyMap(input({ sales: [sale({ amountCents: 3_000, method: 'SALDO', platformBps: 1000, serviceFeeSaldoCents: 3_000 })] }));
    expect(all.split.commissions.platformCents).toBe(0);
    const none = buildMoneyMap(input({ sales: [sale({ amountCents: 3_000, method: 'SALDO', platformBps: 1000 })] }));
    expect(none.split.commissions.platformCents).toBe(300);
  });
});

describe('lo de OxioPay (la «Liquidación OxioPay»): la misma cuenta que el mapa', () => {
  it('por concepto: comisión del servicio cobrada (pagos, recargas con tarjeta y en efectivo) − devuelta + plataforma (cobros y saldo)', () => {
    const i = input({
      sales: [
        // Pago directo con la comisión encendida: 33 € + 3,30 €, sin el % antiguo.
        sale({ amountCents: 3_300, tipCents: 200, method: 'CARD', platformBps: 0, serviceFeeCents: 330 }),
        // Otro con el interruptor apagado: el 10 % antiguo (2 €).
        sale({ amountCents: 2_000, method: 'POS', platformBps: 1000 }),
        // Saldo: 30 € de los que 10 € se cargaron con comisión → 10 % de 20 € (2 €).
        sale({ amountCents: 3_000, method: 'SALDO', platformBps: 1000, serviceFeeSaldoCents: 1_000 }),
      ],
      topUps: { cardCents: 5_000, cardCount: 1, cashCents: 10_000, cashCount: 1, cardFeeCents: 600, cashFeeCents: 1_200 },
      cardRefunds: { cents: 1_100, count: 1, serviceFeeCents: 95 },
    });
    const owed = oxioPayOwedOf(i);
    expect(owed).toEqual({
      serviceFeeSales: 330,
      serviceFeeCardTopUps: 600,
      serviceFeeCashTopUps: 1_200,
      serviceFeeRefunded: -95,
      platformSales: 200,
      platformSaldo: 200,
    });
    const m = buildMoneyMap(i);
    // Suma de los conceptos = lo que el mapa pone como de OxioPay (comisión del servicio + plataforma).
    expect(oxioPayCentsOf(m)).toBe(m.serviceFee!.owedCents + m.split.commissions.platformCents);
    expect(Object.values(owed).reduce((a, b) => a + b, 0)).toBe(oxioPayCentsOf(m));
    expect(owed.platformSales + owed.platformSaldo).toBe(platformCommissionCents(i.sales));
  });

  it('sin comisión del servicio: solo la de plataforma (el mapa de siempre, sin serviceFee)', () => {
    const i = input();
    const m = buildMoneyMap(i);
    expect(m).not.toHaveProperty('serviceFee');
    const owed = oxioPayOwedOf(i);
    expect(owed.serviceFeeSales + owed.serviceFeeCardTopUps + owed.serviceFeeCashTopUps + owed.serviceFeeRefunded).toBe(0);
    expect(owed.platformSales + owed.platformSaldo).toBe(m.split.commissions.platformCents);
    expect(oxioPayCentsOf(m)).toBe(m.split.commissions.platformCents);
  });
});

describe('mapa del dinero con un cobro en bitcoin (BTCPay)', () => {
  const withBitcoin = (o: Partial<MoneyMapInput> = {}) =>
    input({
      sales: [
        ...input().sales,
        // 2 copas pagadas con bitcoin, con comisión del servicio del 10 %.
        sale({ amountCents: 5_000, tipCents: 0, method: 'BITCOIN', platformBps: 0, serviceFeeCents: 500, lines: [{ category: 'VENUE_BAR', amountCents: 5_000 }] }),
      ],
      ...o,
    });

  it('es una venta con método nuevo: suma a lo vendido y a sus secciones, pero no al carril del banco', () => {
    const m = buildMoneyMap(withBitcoin());
    expect(m.salesCents).toBe(36_000);
    expect(m.inflow.bitcoinCents).toBe(5_000);
    expect(m.inflow.cardRailCents).toBe(19_000);
    expect(m.inflow.cardRailCents + m.inflow.cashCents + m.inflow.saldoCents + (m.inflow.bitcoinCents ?? 0)).toBe(m.salesCents);
    expect(m.sections.reduce((a, s) => a + s.amountCents, 0)).toBe(m.salesCents);
    const s = m.split;
    expect(s.venueCents + s.chicasCents + s.camarerosCents + s.commissions.totalCents).toBe(m.salesCents);
  });

  it('el dinero no entra en el banco: va en «Bitcoin, en la cartera del local» (venta + su comisión del servicio) y suma al total', () => {
    const m = buildMoneyMap(withBitcoin());
    expect(m.where.bbvaCents).toBe(19_000 + 20_000 - 1_000);
    expect(m.where.bitcoinCents).toBe(5_500);
    expect(m.where.totalCents).toBe(m.where.bbvaCents + m.where.cashBoxCents + 5_500);
  });

  it('banco + caja + bitcoin = lo de cada dueño', () => {
    const m = buildMoneyMap(withBitcoin());
    const o = m.where.owners;
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(m.where.totalCents);
  });

  it('la comisión del servicio en bitcoin se debe a OxioPay igual, pero no cuenta como entrada del banco ni paga comisión de banco', () => {
    const base = buildMoneyMap(input({ bankFeeBps: 50 }));
    const m = buildMoneyMap(withBitcoin({ bankFeeBps: 50 }));
    expect(m.serviceFee).toMatchObject({ salesCents: 500, owedCents: 500 });
    expect(m.split.commissions.bankCents).toBe(base.split.commissions.bankCents);
    expect(m.where.owners.oxioPayCents).toBe(500);
  });

  it('una recarga pagada con bitcoin suma al saldo vivo una sola vez y no entra en el banco', () => {
    const m = buildMoneyMap(
      input({ topUps: { cardCents: 20_000, cardCount: 1, cashCents: 10_000, cashCount: 1, bitcoinCents: 4_000, bitcoinCount: 1, bitcoinFeeCents: 400 } }),
    );
    expect(m.inflow.topUps).toEqual({ totalCents: 34_000, cardCents: 20_000, cashCents: 10_000, bitcoinCents: 4_000, count: 3 });
    expect(m.where.bbvaCents).toBe(19_000 + 20_000 - 1_000);
    expect(m.where.bitcoinCents).toBe(4_400);
    // Saldo que deja el periodo: 340 € de recargas − 120 gastados − 20 devueltos.
    expect(m.where.owners.saldoCents).toBe(34_000 - 12_000 - 2_000);
    const o = m.where.owners;
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(m.where.totalCents);
  });

  it('lo devuelto fuera en bitcoin baja la cartera, no el banco', () => {
    const m = buildMoneyMap(withBitcoin({ bitcoinRefunds: { cents: 1_000, count: 1 } }));
    expect(m.where.bbvaCents).toBe(19_000 + 20_000 - 1_000);
    expect(m.where.bitcoinCents).toBe(4_500);
  });

  it('sin bitcoin el mapa es el de siempre: ni un campo nuevo', () => {
    const m = buildMoneyMap(input());
    expect(m.inflow).not.toHaveProperty('bitcoinCents');
    expect(m.inflow.topUps).not.toHaveProperty('bitcoinCents');
    expect(m.where).not.toHaveProperty('bitcoinCents');
  });

  it('saleMethodOf: por el proveedor del cobro, antes que el resto', () => {
    const p = { captureMethod: 'QR', posOperationNumber: null, approvedPayMethod: null };
    expect(saleMethodOf({ ...p, provider: 'BTCPAY' })).toBe('BITCOIN');
    expect(saleMethodOf({ ...p, provider: 'REDSYS' })).toBe('CARD');
    expect(saleMethodOf({ ...p, approvedPayMethod: 'bitcoin', provider: 'BTCPAY' })).toBe('BITCOIN');
    expect(saleMethodOf(p)).toBe('CARD');
  });
});

describe('el efectivo de los cajeros de otras plataformas (API de socios, PR 3 B)', () => {
  const ownersSum = (m: ReturnType<typeof buildMoneyMap>) => {
    const o = m.where.owners;
    return o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0);
  };
  // 90 € cargados en los cajeros: ya están en las recargas en efectivo (y en el saldo), no en la caja de recepción.
  const withPartner = (partnerCents: number) =>
    buildMoneyMap(
      input({
        topUps: { cardCents: 20_000, cardCount: 1, cashCents: 10_000 + partnerCents, cashCount: 2 },
        cashBox: { openingFloatCents: 5_000, inCents: 10_000, outCents: 2_000, expectedCents: 13_000, partnerCashCents: partnerCents },
      }),
    );

  it('suma partnerCashCents una sola vez al total, y owners suma el total', () => {
    const base = buildMoneyMap(input());
    const m = withPartner(9_000);
    expect(m.where.partnerCashCents).toBe(9_000);
    expect(m.where.cashBoxCents).toBe(13_000);
    expect(m.where.totalCents).toBe(m.where.bbvaCents + m.where.cashBoxCents + 9_000);
    expect(m.where.totalCents).toBe(base.where.totalCents + 9_000);
    expect(ownersSum(m)).toBe(m.where.totalCents);
    // El saldo cargado en los cajeros es del cliente: el local no gana nada por él.
    expect(m.where.owners.venueCents).toBe(base.where.owners.venueCents);
    expect(m.where.owners.saldoCents).toBe(base.where.owners.saldoCents + 9_000);
  });

  it('negativo (una noche con solo una anulación del panel): sale y owners sigue sumando el total', () => {
    const m = withPartner(-2_500);
    expect(m.where.partnerCashCents).toBe(-2_500);
    expect(m.where.totalCents).toBe(m.where.bbvaCents + m.where.cashBoxCents - 2_500);
    expect(ownersSum(m)).toBe(m.where.totalCents);
  });

  it('con 0 (o sin el campo), no sale', () => {
    expect('partnerCashCents' in withPartner(0).where).toBe(false);
    expect('partnerCashCents' in buildMoneyMap(input()).where).toBe(false);
  });
});
