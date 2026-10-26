import { describe, expect, it } from 'vitest';
import { cobrosCsv, devolucionesCsv, recargasEfectivoCsv, resumenCsv, summarize } from './export-csv';
import type { CobroRow, ConsumoRow, DevolucionRow, RecargaEfectivoRow } from './export-rows';
import { parseReportPeriod } from './report-period';
import { cashFromRows } from '../nights/night-rules';

/**
 * Informes con la «Comisión del servicio»: lo cobrado la incluye, lo del local
 * no (se debe a OxioPay), la parte de la chica va sobre el consumo y todo
 * cuadra: neto = chicas + camareros + OxioPay + local.
 *
 * La noche: un servicio de 33 € de Lola (90 %) con 3,30 € de comisión y 2 € de
 * propina (pagado con tarjeta, 38,30 €); una recarga con tarjeta de 50 € + 6 €;
 * una recarga en efectivo de 50 € + 6 €; un consumo del saldo de 20 € (sin
 * comisión); se devuelve la mitad del servicio (19,15 €: 1,65 € de comisión).
 */

const servicio = (o: Partial<CobroRow> = {}): CobroRow => ({
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-13T21:41:00Z'),
  status: 'PARTIALLY_REFUNDED',
  amountCents: 3300,
  tipCents: 200,
  serviceFeeCents: 330,
  refundedServiceFeeCents: 165,
  revenueCategory: 'CHICA_SERVICE',
  captureMethod: 'QR',
  serviceName: '30 min',
  payMethod: 'card',
  payMethodCode: null,
  cardBrand: null,
  cardType: null,
  cardCountry: null,
  authCode: null,
  providerTxId: 'ORD1',
  walletId: null,
  creatorName: 'Lola',
  creatorEmail: 'lola@local.es',
  earningOperatorName: 'Lola',
  earningOperatorEmail: 'lola@local.es',
  refundedCents: 1915,
  commissionCents: 2970,
  earningTipCents: 200,
  // La mitad de lo suyo (2970 + 200) en proporción a lo cobrado: 3170 × 1915 / 3830.
  reversedCents: 1585,
  reversedAfterPayoutCents: 0,
  ...o,
});

const recargaTarjeta: CobroRow = {
  ...servicio(),
  id: 'w1',
  status: 'AUTHORIZED',
  amountCents: 5000,
  tipCents: 0,
  serviceFeeCents: 600,
  refundedServiceFeeCents: 0,
  revenueCategory: 'EXTRA',
  captureMethod: 'WALLET_TOPUP',
  serviceName: null,
  walletId: 'wallet-1',
  refundedCents: 0,
  commissionCents: null,
  earningTipCents: null,
  reversedCents: null,
  staff: [],
};

const consumo: ConsumoRow = {
  id: 'c1',
  at: new Date('2026-10-13T22:00:00Z'),
  amountCents: 2000,
  tipCents: 0,
  category: 'VENUE_BAR',
  operatorName: null,
  operatorEmail: null,
  commissionCents: null,
  earningTipCents: null,
  staff: [],
};

const devolucion: DevolucionRow = {
  id: 'refund-1',
  refundedAt: new Date('2026-10-13T23:00:00Z'),
  amountCents: 1915,
  serviceFeeCents: 165,
  reason: 'Mitad',
  providerRefundId: null,
  registeredManually: true,
  byName: 'Dueño',
  byEmail: 'owner@local.es',
  paymentId: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-13T21:41:00Z'),
  providerTxId: 'ORD1',
  chargedCents: 3830,
  creatorName: 'Lola',
  creatorEmail: 'lola@local.es',
  chicaName: 'Lola',
  chicaEmail: 'lola@local.es',
  reversedDeltaCents: 1585,
  afterPayout: false,
};

const efectivo: RecargaEfectivoRow = {
  id: 'ct1',
  at: new Date('2026-10-13T21:00:00Z'),
  amountCents: 5000,
  serviceFeeCents: 600,
  createdWallet: true,
  takenByName: 'Recepción',
  takenByEmail: null,
  terminalLabel: null,
};

const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

describe('resumen con la comisión del servicio', () => {
  const s = summarize([servicio(), recargaTarjeta], [devolucion], [], [consumo], [], [efectivo]);

  it('lo cobrado la incluye; aparte, la cobrada, la devuelta y lo que se debe a OxioPay', () => {
    expect(s).toMatchObject({
      grossCents: 8300,
      tipsCents: 200,
      walletCashTopUpsCents: 5000,
      serviceFeeCents: 1530,
      serviceFeeCashCents: 600,
      serviceFeeRefundedCents: 165,
      serviceFeeNetCents: 1365,
      chargedCents: 8300 + 200 + 5000 + 1530,
      refundsCents: 1915,
      netCents: 8300 + 200 + 5000 + 1530 - 1915,
    });
  });

  it('la chica, sobre el consumo (nunca sobre la comisión); el local, sin lo de OxioPay; cuadra', () => {
    expect(s.chicaNetCents).toBe(2970 + 200 - 1585);
    expect(s.venueNetCents).toBe(s.netCents - s.chicaNetCents - (s.camareroNetCents ?? 0) - 1365);
    expect(s.venueNetCents + s.chicaNetCents + (s.camareroNetCents ?? 0) + (s.serviceFeeNetCents ?? 0)).toBe(s.netCents);
  });

  it('por tipo, una línea «Comisión del servicio» (así el total por tipo es lo cobrado)', () => {
    expect(s.byType).toContainEqual({ label: 'Comisión del servicio', count: 3, chargedCents: 1530 });
    expect(s.byType.reduce((a, t) => a + t.chargedCents, 0)).toBe(s.chargedCents);
  });

  it('sin comisión, todo como siempre (sin la línea ni cifras de más)', () => {
    const plain = summarize([servicio({ serviceFeeCents: 0, refundedServiceFeeCents: 0 })], [], []);
    expect(plain).toMatchObject({ chargedCents: 3500 });
    for (const k of ['serviceFeeCents', 'serviceFeeCashCents', 'serviceFeeRefundedCents', 'serviceFeeNetCents']) {
      expect(plain).not.toHaveProperty(k);
    }
    expect(plain.byType.map((t) => t.label)).not.toContain('Comisión del servicio');
  });
});

describe('CSV de la gestoría con la comisión del servicio', () => {
  it('libro de cobros: columna «Comisión del servicio», el total con ella y la parte de OxioPay aparte de la del local', () => {
    const [header, row] = lines(cobrosCsv([servicio()], 'Local'));
    const cols = header.split(';');
    const at = (name: string) => row!.split(';')[cols.indexOf(name)];
    // Al final: las columnas de siempre no se mueven (plantillas de la gestoría).
    expect(cols.slice(-2)).toEqual(['Comisión del servicio', 'Parte OxioPay']);
    expect(cols.indexOf('Total cobrado')).toBe(cols.indexOf('Propina') + 1);
    expect(at('Importe')).toBe('33,00');
    expect(at('Propina')).toBe('2,00');
    expect(at('Comisión del servicio')).toBe('3,30');
    expect(at('Total cobrado')).toBe('38,30');
    expect(at('Devuelto')).toBe('19,15');
    expect(at('Neto')).toBe('19,15');
    expect(at('Parte chica')).toBe('15,85');
    expect(at('Parte OxioPay')).toBe('1,65');
    // 19,15 − 15,85 − 1,65
    expect(at('Parte local')).toBe('1,65');
  });

  it('sin comisión en ninguna fila: el CSV de siempre (sin sus columnas)', () => {
    const plain = servicio({ serviceFeeCents: 0, refundedServiceFeeCents: 0 });
    const [header] = lines(cobrosCsv([plain], 'Local'));
    expect(header).not.toContain('Comisión del servicio');
    expect(header).not.toContain('Parte OxioPay');
    expect(header!.endsWith(';Parte local;Estado;Referencia OxioPay;Por sección')).toBe(true);
    expect(lines(devolucionesCsv([{ ...devolucion, serviceFeeCents: 0 }]))[0]).not.toContain('Comisión del servicio');
    expect(lines(recargasEfectivoCsv([{ ...efectivo, serviceFeeCents: 0 }]))[0]).not.toContain('Comisión del servicio');
  });

  it('devoluciones: la comisión del servicio devuelta', () => {
    const [header, row] = lines(devolucionesCsv([devolucion]));
    const cols = header.split(';');
    expect(cols.at(-1)).toBe('Comisión del servicio devuelta');
    expect(row!.split(';')[cols.indexOf('Comisión del servicio devuelta')]).toBe('1,65');
    expect(row!.split(';')[cols.indexOf('Total cobrado')]).toBe('38,30');
  });

  it('recargas en efectivo: el saldo, la comisión y lo cobrado', () => {
    const [header, row] = lines(recargasEfectivoCsv([efectivo]));
    const cols = header.split(';');
    const at = (name: string) => row!.split(';')[cols.indexOf(name)];
    expect(cols.slice(-2)).toEqual(['Comisión del servicio', 'Cobrado']);
    expect(at('Importe')).toBe('50,00');
    expect(at('Comisión del servicio')).toBe('6,00');
    expect(at('Cobrado')).toBe('56,00');
  });

  it('resumen: la comisión del servicio, lo que se debe a OxioPay y lo del local sin ella', () => {
    const parsed = parseReportPeriod('2026-10-13', '2026-10-13');
    if (!parsed.ok) throw new Error(parsed.error);
    const summary = summarize([servicio(), recargaTarjeta], [devolucion], [], [consumo], [], [efectivo]);
    const csv = resumenCsv({ venueName: 'Local', period: parsed.period, generatedAt: new Date('2026-10-14T09:00:00Z'), summary });
    expect(csv).toContain('Comisión del servicio cobrada;15,30;3');
    expect(csv).toContain('Comisión del servicio devuelta;-1,65');
    expect(csv).toContain('Comisión del servicio · se debe a OxioPay;13,65');
  });
});

describe('caja de la noche con la comisión del servicio de las recargas en efectivo', () => {
  it('entra saldo + comisión (56 €); la comisión va aparte y se debe a OxioPay', () => {
    const cash = cashFromRows(10_000, { recargasEfectivo: [efectivo], pagosSaldo: [], liquidaciones: [] });
    expect(cash).toMatchObject({
      cashInCents: 5600,
      walletCashTopUpsCents: 5000,
      walletCashTopUpFeesCents: 600,
      expectedCents: 15_600,
    });
  });

  it('una anulación devuelve también su comisión (las dos, en negativo)', () => {
    const anulada: RecargaEfectivoRow = { ...efectivo, id: 'ct2', amountCents: -5000, serviceFeeCents: -600, voidOfId: 'ct1' };
    const cash = cashFromRows(0, { recargasEfectivo: [efectivo, anulada], pagosSaldo: [], liquidaciones: [] });
    expect(cash).toMatchObject({ cashInCents: 0, walletCashTopUpsCents: 0, expectedCents: 0 });
    // Quedó en 0: la caja sale como sin comisión.
    expect(cash).not.toHaveProperty('walletCashTopUpFeesCents');
  });

  it('sin comisión: la caja de siempre (sin el campo)', () => {
    const cash = cashFromRows(0, { recargasEfectivo: [{ ...efectivo, serviceFeeCents: 0 }], pagosSaldo: [], liquidaciones: [] });
    expect(cash).not.toHaveProperty('walletCashTopUpFeesCents');
    expect(cash.cashInCents).toBe(5000);
  });
});
