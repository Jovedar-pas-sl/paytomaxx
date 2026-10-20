import { describe, it, expect } from 'vitest';
import { cobrosCsv, devolucionesCsv, liquidacionesCsv, resumenCsv, summarize } from './export-csv';
import type { CobroRow, ConsumoRow, DevolucionRow, LiquidacionRow, PagoSaldoRow } from './export-rows';
import { parseReportPeriod } from './report-period';

const cobro = (o: Partial<CobroRow>): CobroRow => ({
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-13T21:41:00Z'),
  status: 'AUTHORIZED',
  amountCents: 10_000,
  tipCents: 500,
  revenueCategory: 'CHICA_SERVICE',
  captureMethod: 'QR',
  serviceName: '30 min',
  payMethod: 'wallet',
  payMethodCode: '78',
  cardBrand: '1',
  cardType: 'D',
  cardCountry: '724',
  authCode: '047215',
  providerTxId: '1234ABCD5678',
  walletId: null,
  creatorName: 'Lola',
  creatorEmail: 'lola@local.es',
  earningOperatorName: 'Lola',
  earningOperatorEmail: 'lola@local.es',
  refundedCents: 0,
  commissionCents: 9000,
  earningTipCents: 500,
  reversedCents: 0,
  reversedAfterPayoutCents: 0,
  ...o,
});

const devolucion = (o: Partial<DevolucionRow>): DevolucionRow => ({
  id: 'refund-1',
  refundedAt: new Date('2026-10-14T12:00:00Z'),
  amountCents: 10_500,
  reason: 'No reconoce el cargo',
  providerRefundId: 'DEV-1',
  registeredManually: true,
  byName: 'Dueño',
  byEmail: 'owner@local.es',
  paymentId: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-13T21:41:00Z'),
  providerTxId: '1234ABCD5678',
  chargedCents: 10_500,
  creatorName: 'Lola',
  creatorEmail: 'lola@local.es',
  chicaName: 'Lola',
  chicaEmail: 'lola@local.es',
  reversedDeltaCents: 9000,
  afterPayout: true,
  ...o,
});

const liquidacion = (o: Partial<LiquidacionRow>): LiquidacionRow => ({
  id: 'payout-1',
  paidAt: new Date('2026-10-20T10:00:00Z'),
  totalCents: 50_000,
  externalRail: 'SEPA',
  externalTxId: 'TRF-9',
  reconciliationStatus: 'RECONCILED',
  notes: null,
  operatorName: 'Lola',
  operatorEmail: 'lola@local.es',
  paidByName: null,
  paidByEmail: 'owner@local.es',
  earningCount: 6,
  ...o,
});

const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

describe('libro de cobros', () => {
  it('una fila por cobro con importe, propina, método, marca, autorización y reparto', () => {
    const [header, row] = lines(cobrosCsv([cobro({})], 'Local Centro'));
    expect(header).toContain('Fecha;Hora;Local;Código;Concepto;Tipo;Cobrado por');
    expect(row).toBe(
      '13/10/2026;23:41;Local Centro;"=""A6B""";30 min;Servicio de chica;Lola;Móvil (QR);Apple Pay / Google Pay;Visa;Débito;"=""724""";"=""047215""";"=""1234ABCD5678""";100,00;5,00;105,00;0,00;105,00;95,00;10,00;Pagado;7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b;Servicio de chica 100,00',
    );
  });

  it('barra cobrada por el camarero: todo para el local; devolución parcial descontada', () => {
    const [, row] = lines(
      cobrosCsv(
        [
          cobro({
            revenueCategory: 'VENUE_BAR',
            serviceName: null,
            tipCents: 0,
            commissionCents: null,
            earningTipCents: null,
            reversedCents: null,
            refundedCents: 2000,
            status: 'PARTIALLY_REFUNDED',
            creatorName: null,
            creatorEmail: 'barra@local.es',
          }),
        ],
        'Local',
      ),
    );
    expect(row).toContain(';Barra;Barra;barra@local.es;');
    expect(row).toContain(';100,00;0,00;100,00;20,00;80,00;0,00;80,00;Devuelto en parte;');
  });

  it('devolución después de pagar a la chica: su parte descuenta la deuda, como el resumen', () => {
    // Se devuelve la mitad (52,50 €) con la chica ya pagada: no toca reversedCents,
    // queda como deuda de 47,50 € (comisión + propina en proporción).
    const c = cobro({ status: 'PARTIALLY_REFUNDED', refundedCents: 5250, reversedCents: 0, reversedAfterPayoutCents: 4750 });
    const [, row] = lines(cobrosCsv([c], 'Local'));
    expect(row).toContain(';100,00;5,00;105,00;52,50;52,50;47,50;5,00;Devuelto en parte;');
    const s = summarize([c], [devolucion({ amountCents: 5250, reversedDeltaCents: 4750, afterPayout: true })], []);
    expect(s.chicaNetCents).toBe(4750);
  });
});

describe('devoluciones y pagos a chicas', () => {
  it('devolución con lo descontado a la chica y si ya se le había pagado', () => {
    const [header, row] = lines(devolucionesCsv([devolucion({})]));
    expect(header.split(';')).toHaveLength(14);
    expect(row).toBe(
      '14/10/2026;105,00;No reconoce el cargo;DEV-1;Sí;Dueño;13/10/2026;"=""A6B""";"=""1234ABCD5678""";105,00;Lola;90,00;Sí;refund-1',
    );
  });

  it('pago a una chica', () => {
    const [, row] = lines(liquidacionesCsv([liquidacion({})]));
    expect(row).toBe('20/10/2026;Lola;500,00;6;SEPA;TRF-9;Conciliado;owner@local.es;;payout-1');
  });
});

describe('resumen', () => {
  const cobros = [
    cobro({}),
    cobro({
      id: 'b',
      revenueCategory: 'VENUE_BAR',
      tipCents: 200,
      commissionCents: null,
      earningTipCents: null,
      reversedCents: null,
      amountCents: 3000,
    }),
    cobro({ id: 'w', walletId: 'w-1', revenueCategory: 'EXTRA', tipCents: 0, commissionCents: null, earningTipCents: null }),
  ];
  const s = summarize(cobros, [devolucion({})], [liquidacion({})]);

  it('totales: cobrado, propinas, devoluciones del periodo y neto', () => {
    expect(s).toMatchObject({
      count: 3,
      grossCents: 23_000,
      tipsCents: 700,
      chargedCents: 23_700,
      refundsCents: 10_500,
      netCents: 13_200,
    });
  });

  it('reparto: chicas (comisión + propina − descuentos) y el resto para el local', () => {
    expect(s).toMatchObject({
      chicaCommissionCents: 9000,
      chicaTipsCents: 500,
      chicaReversalsCents: 9000,
      chicaNetCents: 500,
      venueTipsCents: 200,
      venueNetCents: 12_700,
      payoutsCents: 50_000,
      payoutsCount: 1,
    });
  });

  it('por tipo, con las recargas de wallet aparte', () => {
    expect(s.byType).toEqual([
      { label: 'Servicio de chica', count: 1, chargedCents: 10_500 },
      { label: 'Barra', count: 1, chargedCents: 3200 },
      { label: 'Recarga de wallet', count: 1, chargedCents: 10_000 },
    ]);
  });

  it('por chica: lo generado, lo descontado y lo pagado', () => {
    expect(s.perChica).toEqual([
      {
        name: 'Lola',
        count: 1,
        chargedCents: 10_500,
        commissionCents: 9000,
        tipsCents: 500,
        reversalsCents: 9000,
        netCents: 500,
        paidCents: 50_000,
      },
    ]);
  });

  it('propina para una chica en un cobro del encargado → cuenta para ella, no para quien cobró', () => {
    const t = summarize(
      [
        cobro({
          id: 'o',
          revenueCategory: 'VENUE_BAR',
          commissionCents: 0,
          earningTipCents: 1000,
          creatorName: 'Encargado',
          creatorEmail: 'jefe@local.es',
          earningOperatorName: 'Ana',
          earningOperatorEmail: 'ana@local.es',
        }),
      ],
      [],
      [],
    );
    expect(t.perChica).toEqual([expect.objectContaining({ name: 'Ana', tipsCents: 1000, netCents: 1000 })]);
  });

  it('el CSV del resumen lleva periodo, totales, notas de IVA y la tabla por chica', () => {
    const r = parseReportPeriod('2026-10-01', '2026-10-31');
    if (!r.ok) throw new Error(r.error);
    const csv = resumenCsv({
      venueName: 'Local Centro',
      period: r.period,
      generatedAt: new Date('2026-11-02T09:00:00Z'),
      summary: s,
    });
    expect(csv).toContain('Periodo;01/10/2026 – 31/10/2026');
    expect(csv).toContain('Neto cobrado;132,00');
    expect(csv).toContain('Devoluciones del periodo;-105,00;1');
    expect(csv).toContain('Total para las chicas;5,00');
    expect(csv).toContain('intermediario');
    expect(csv).toContain('Lola;1;105,00;90,00;5,00;-90,00;5,00;500,00');
  });
});

const consumo = (o: Partial<ConsumoRow>): ConsumoRow => ({
  id: 'c1',
  at: new Date('2026-10-13T23:00:00Z'),
  amountCents: 6000,
  tipCents: 1000,
  category: 'CHICA_SERVICE',
  operatorName: 'Lola',
  operatorEmail: 'lola@local.es',
  commissionCents: 5400,
  earningTipCents: 1000,
  ...o,
});

describe('resumen: lo que las chicas cobran del saldo del cliente', () => {
  const cobros = [cobro({})];
  const sin = summarize(cobros, [], []);
  const con = summarize(cobros, [], [], [consumo({}), consumo({ id: 'c2', operatorName: 'Ana', operatorEmail: 'ana@local.es', tipCents: 0, earningTipCents: 0, commissionCents: 2700, amountCents: 3000 })]);

  it('su parte cuenta para ellas y sale de lo del local (el dinero entró con la recarga)', () => {
    expect(con.chicaCommissionCents).toBe(sin.chicaCommissionCents + 5400 + 2700);
    expect(con.chicaTipsCents).toBe(sin.chicaTipsCents + 1000);
    expect(con.chicaNetCents).toBe(sin.chicaNetCents + 9100);
    expect(con.venueNetCents).toBe(sin.venueNetCents - 9100);
    // Lo cobrado y las propinas con tarjeta no cambian: no es dinero nuevo.
    expect(con.chargedCents).toBe(sin.chargedCents);
    expect(con.venueTipsCents).toBe(sin.venueTipsCents);
  });

  it('por chica: los consumos se suman a los cobros con tarjeta', () => {
    const lola = con.perChica.find((c) => c.name === 'Lola')!;
    expect(lola).toMatchObject({ count: 2, chargedCents: 10_500 + 7000, commissionCents: 9000 + 5400, tipsCents: 500 + 1000 });
    expect(con.perChica.find((c) => c.name === 'Ana')).toMatchObject({ count: 1, commissionCents: 2700, netCents: 2700 });
  });
});

describe('resumen: el saldo del cliente (recarga, consumos y lo que se le devuelve)', () => {
  // Recarga de 200 €; gasta 60 + 10 de propina con Lola y 50 en barra (sin chica).
  const recarga = cobro({
    id: 'w',
    walletId: 'w-1',
    revenueCategory: 'EXTRA',
    captureMethod: 'WALLET_TOPUP',
    amountCents: 20_000,
    tipCents: 0,
    commissionCents: null,
    earningTipCents: null,
    reversedCents: null,
    earningOperatorName: null,
    earningOperatorEmail: null,
  });
  const consumos = [
    consumo({}),
    consumo({
      id: 'c2',
      category: 'VENUE_BAR',
      amountCents: 5000,
      tipCents: 0,
      operatorName: null,
      operatorEmail: null,
      commissionCents: null,
      earningTipCents: null,
    }),
  ];
  const pago = (o: Partial<PagoSaldoRow>): PagoSaldoRow => ({
    id: 'wp-1',
    at: new Date('2026-10-14T03:00:00Z'),
    amountCents: 8000,
    method: 'CASH',
    paidByName: 'Encargado',
    paidByEmail: 'jefe@local.es',
    ...o,
  });

  it('devuelto en efectivo: resta del neto (recarga 200, devuelve 80 → cuenta 120)', () => {
    const s = summarize([recarga], [], [], consumos, [pago({})]);
    expect(s).toMatchObject({
      chargedCents: 20_000,
      refundsCents: 0,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 8000,
      netCents: 12_000,
    });
    expect(s.venueNetCents).toBe(12_000 - s.chicaNetCents);
  });

  it('devuelto a la tarjeta: ya es una devolución de la recarga, no se resta dos veces', () => {
    const refund = devolucion({ amountCents: 8000, chargedCents: 20_000, reversedDeltaCents: null, afterPayout: null, chicaName: null, chicaEmail: null });
    const s = summarize([recarga], [refund], [], consumos, [pago({ method: 'CARD' })]);
    expect(s).toMatchObject({
      refundsCents: 8000,
      walletCardPayoutsCount: 1,
      walletCardPayoutsCents: 8000,
      walletCashPayoutsCents: 0,
      netCents: 12_000,
    });
  });

  it('consumos del saldo por tipo, también los de la barra (sin parte de chica)', () => {
    const s = summarize([recarga], [], [], consumos, []);
    expect(s.consumptionsCount).toBe(2);
    expect(s.consumptionsCents).toBe(7000 + 5000);
    expect(s.saldoByType).toEqual([
      { label: 'Servicio de chica', count: 1, chargedCents: 7000 },
      { label: 'Barra', count: 1, chargedCents: 5000 },
    ]);
    expect(s.perChica.map((c) => c.name)).toEqual(['Lola']);
    expect(s.chicaCommissionCents).toBe(5400);
    // Los consumos no son dinero nuevo: lo cobrado es solo la recarga.
    expect(s.chargedCents).toBe(20_000);
  });

  it('el CSV del resumen enseña lo devuelto del saldo y los consumos por tipo', () => {
    const r = parseReportPeriod('2026-10-01', '2026-10-31');
    if (!r.ok) throw new Error(r.error);
    const summary = summarize([recarga], [], [], consumos, [pago({}), pago({ id: 'wp-2', method: 'CARD', amountCents: 1000 })]);
    const csv = resumenCsv({ venueName: 'Local', period: r.period, generatedAt: new Date('2026-11-02T09:00:00Z'), summary });
    expect(csv).toContain('Saldo devuelto en efectivo;-80,00;1');
    expect(csv).toContain('Neto cobrado;120,00');
    expect(csv).toContain('Consumos del saldo;120,00;2');
    expect(csv).toContain('Barra;50,00;1');
    expect(csv).toContain('Devuelto a la tarjeta (ya está en devoluciones);-10,00;1');
  });
});
