import { describe, it, expect } from 'vitest';
import { buildMoneyMap, type SaleRow } from '../money-map/money-map-rules';
import { summarize } from './export-csv';
import type { CobroRow, ConsumoRow, DevolucionRow, PagoSaldoRow, RecargaEfectivoRow } from './export-rows';

// La noche de la demo (scratchpad/demo/seed/activity.mjs), a mano, para ver qué
// dice cada cifra del panel y por qué Noches y el mapa no dan lo mismo:
//
//  - 9 ventas con tarjeta: 533 € + 26 € de propinas (una de ellas, 3 gin tonic de 36 €,
//    se devuelve en parte: 12 €).
//  - 2 recargas con tarjeta (60 € y 40 €) y 6 en efectivo (450 €).
//  - 11 consumos del saldo: 341 € + 2 € de propina; a la salida, 20 € de saldo en efectivo.
//  - Personal: Marta (15 % de dos reservados de 150 € + 15 € de propina) y Elena (15 % de la
//    botella de 180 € y la mitad de la invitación de 12 €) = 93 €. Comisión de OxioPay: 10 %.
//
// Las del panel (prod, f7a1172, donde la invitación daba además 6 € al camarero y el Z no
// los restaba): «Hoy · cobrado» 1109 € («633 € + 26 € de propinas»), «Para el local» 715,60 €
// en el mapa y 984 € en Noches, «Pagos» 11.

const AT = new Date('2026-10-22T18:30:00Z');

const cobro = (amountCents: number, o: Partial<CobroRow> = {}): CobroRow => ({
  id: `p-${amountCents}`,
  paidAt: AT,
  status: 'AUTHORIZED',
  amountCents,
  tipCents: 0,
  revenueCategory: 'VENUE_BAR',
  lines: null,
  captureMethod: 'QR',
  serviceName: null,
  payMethod: 'wallet',
  payMethodCode: null,
  cardBrand: null,
  cardType: null,
  cardCountry: null,
  authCode: null,
  providerTxId: null,
  walletId: null,
  creatorName: 'Carlos',
  creatorEmail: 'carlos@aurora.example',
  earningOperatorName: null,
  earningOperatorEmail: null,
  refundedCents: 0,
  commissionCents: null,
  earningTipCents: null,
  reversedCents: null,
  reversedAfterPayoutCents: 0,
  ...o,
});

const marta = (o: Partial<CobroRow>): Partial<CobroRow> => ({
  revenueCategory: 'CHICA_SERVICE',
  earningOperatorName: 'Marta',
  earningOperatorEmail: 'marta@aurora.example',
  ...o,
});

const VENTAS_TARJETA: CobroRow[] = [
  cobro(6_600, { lines: [{ category: 'VENUE_ENTRY', amountCents: 3_000 }, { category: 'VENUE_BAR', amountCents: 3_600 }] }),
  cobro(3_300, { tipCents: 200 }),
  cobro(2_800, { tipCents: 500 }),
  cobro(3_600, { refundedCents: 1_200 }),
  cobro(2_300, { tipCents: 200, revenueCategory: 'VENUE_FOOD' }),
  cobro(15_000, marta({ tipCents: 1_500, commissionCents: 2_250, earningTipCents: 1_500 })),
  cobro(15_000, marta({ commissionCents: 2_250, earningTipCents: 0 })),
  cobro(2_200, { tipCents: 200 }),
  cobro(2_500, { revenueCategory: 'VENUE_FOOD' }),
];
const RECARGAS_TARJETA = [cobro(6_000, { walletId: 'w-7', revenueCategory: 'EXTRA' }), cobro(4_000, { walletId: 'w-8', revenueCategory: 'EXTRA' })];
const RECARGAS_EFECTIVO: RecargaEfectivoRow[] = [5_000, 10_000, 2_000, 5_000, 20_000, 3_000].map((amountCents, i) => ({
  id: `ct-${i}`,
  at: AT,
  amountCents,
  takenByName: 'Sergio',
  takenByEmail: 'sergio@aurora.example',
  terminalLabel: null,
}));

const consumo = (amountCents: number, o: Partial<ConsumoRow> = {}): ConsumoRow => ({
  id: `c-${amountCents}`,
  at: AT,
  amountCents,
  tipCents: 0,
  category: 'VENUE_BAR',
  lines: null,
  operatorName: null,
  operatorEmail: null,
  commissionCents: null,
  earningTipCents: null,
  ...o,
});
const elena = { operatorName: 'Elena', operatorEmail: 'elena@aurora.example', earningTipCents: 0 };
const CONSUMOS: ConsumoRow[] = [
  consumo(3_900),
  consumo(1_500, { category: 'VENUE_ENTRY' }),
  consumo(1_800),
  consumo(1_000),
  consumo(1_200),
  consumo(2_000),
  consumo(1_200, { tipCents: 200 }),
  consumo(900, { category: 'VENUE_FOOD' }),
  consumo(18_000, { category: 'CHICA_SERVICE', ...elena, commissionCents: 2_700 }),
  consumo(1_200, { ...elena, commissionCents: 600 }), // la invitación a Elena (12 €): la mitad para ella
  consumo(1_400),
];

const DEVOLUCION: DevolucionRow = {
  id: 'r-1',
  refundedAt: AT,
  amountCents: 1_200,
  reason: 'Copa servida de más',
  providerRefundId: null,
  registeredManually: true,
  byName: 'Daniel',
  byEmail: 'daniel@aurora.example',
  paymentId: 'p-3600',
  paidAt: AT,
  providerTxId: null,
  chargedCents: 3_600,
  creatorName: 'Carlos',
  creatorEmail: 'carlos@aurora.example',
  chicaName: null,
  chicaEmail: null,
  reversedDeltaCents: null,
  afterPayout: null,
};
const SALIDA: PagoSaldoRow = { id: 'wp-1', at: AT, amountCents: 2_000, method: 'CASH', paidByName: 'Sergio', paidByEmail: 'sergio@aurora.example' };

const Z = summarize([...VENTAS_TARJETA, ...RECARGAS_TARJETA], [DEVOLUCION], [], CONSUMOS, [SALIDA], RECARGAS_EFECTIVO);

const sale = (amountCents: number, tipCents: number, category: string, method: SaleRow['method']): SaleRow => ({
  amountCents,
  tipCents,
  category,
  method,
  platformBps: 1_000,
  lines: [],
});
const MAPA = buildMoneyMap({
  scope: { kind: 'night', nightId: 'n-1', open: true },
  window: { from: new Date('2026-10-22T16:00:00Z'), to: new Date('2026-10-22T20:00:00Z') },
  now: new Date('2026-10-22T20:00:00Z'),
  frozen: false,
  sales: [
    ...VENTAS_TARJETA.map((c) => sale(c.amountCents, c.tipCents, c.revenueCategory, 'MOBILE_WALLET')),
    ...CONSUMOS.map((c) => sale(c.amountCents, c.tipCents, c.category, 'SALDO')),
  ],
  topUps: { cardCents: 10_000, cardCount: 2, cashCents: 45_000, cashCount: 6 },
  staff: { chicas: { grossCents: 9_300, unpaidCents: 9_300 }, camareros: { grossCents: 0, unpaidCents: 0 } },
  cardRefunds: { cents: 1_200, count: 1 },
  walletPayouts: { cashCents: 2_000, cashCount: 1, cardCents: 0 },
  payouts: [],
  cashBox: { openingFloatCents: 20_000, inCents: 45_000, outCents: 2_000, expectedCents: 63_000 },
  bankFeeBps: null,
  liveSaldoCents: null,
  owed: null,
});

describe('la noche de la demo, a mano: qué dice cada cifra', () => {
  it('el Z (Noches, «Hoy · cobrado»): 1109 € cobrados = 533 de ventas + 26 de propinas + 550 de recargas', () => {
    expect(Z.chargedCents).toBe(110_900);
    expect(Z.grossCents).toBe(63_300); // el «633 €» del subtítulo de antes: 533 de ventas + 100 de recargas con tarjeta
    expect(Z.tipsCents).toBe(2_600);
    expect(Z).toMatchObject({ walletCardTopUpsCount: 2, walletCardTopUpsCents: 10_000, walletCashTopUpsCount: 6, walletCashTopUpsCents: 45_000 });
    const ventas = Z.grossCents - Z.walletCardTopUpsCents!;
    const recargas = Z.walletCardTopUpsCents! + Z.walletCashTopUpsCents!;
    expect([ventas, Z.tipsCents, recargas]).toEqual([53_300, 2_600, 55_000]);
    expect(ventas + Z.tipsCents + recargas).toBe(Z.chargedCents);
  });

  it('«Pagos» 11: los pagos con tarjeta (9 ventas + 2 recargas), sin los 11 del saldo ni las 6 recargas en efectivo', () => {
    expect(Z.count).toBe(11);
    expect(Z.consumptionsCount).toBe(11);
    expect(Z.walletCashTopUpsCount).toBe(6);
  });

  it('Noches: neto 1077 € (1109 − 12 devueltos − 20 de saldo en efectivo); sin el personal (93 €), 984 €', () => {
    expect(Z.netCents).toBe(107_700);
    expect(Z.chicaNetCents).toBe(9_300);
    expect(Z.camareroNetCents).toBe(0);
    expect(Z.venueNetCents).toBe(98_400);
  });

  it('el mapa: ventas 902 € (tarjeta 559 + saldo 343); «Para el local» = 902 − 93 de personal − 87,40 de OxioPay = 721,60 €', () => {
    expect(MAPA.salesCents).toBe(90_200);
    expect([MAPA.inflow.cardRailCents, MAPA.inflow.saldoCents]).toEqual([55_900, 34_300]);
    expect(MAPA.split.commissions.platformCents).toBe(8_740);
    expect(MAPA.split.venueCents).toBe(72_160);
    // En prod la invitación daba 6 € al camarero: 902 − 99 − 87,40 = 715,60 (la captura).
    expect(MAPA.salesCents - 9_900 - 8_740).toBe(71_560);
  });

  it('984 ≠ 721,60: no es un error de suma, son dos conceptos (por eso el del Z ya no se llama «Para el local»)', () => {
    const saldoDeLosClientes = MAPA.where.owners.saldoCents; // 550 recargado − 343 gastado − 20 devuelto
    expect(saldoDeLosClientes).toBe(18_700);
    expect(Z.venueNetCents - MAPA.split.venueCents).toBe(26_240);
    // El Z cuenta las recargas que siguen siendo de los clientes, no resta la comisión de
    // OxioPay y sí resta la devolución (que el mapa pone en «Qué sale»).
    expect(saldoDeLosClientes + MAPA.split.commissions.platformCents - MAPA.outflow.refunds.cardCents).toBe(26_240);
  });
});
