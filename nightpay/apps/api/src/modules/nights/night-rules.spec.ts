import { describe, it, expect } from 'vitest';
import { evaluateCash, type NightCash } from '@nightpay/contracts';
import { summarize } from '../reports/export-csv';
import type { CobroRow, ConsumoRow, DevolucionRow } from '../reports/export-rows';
import { autoCloseAt, buildAdjustments, buildNightCaja, buildNightZ, cashFromRows, unresolvedPaymentsWhere, zStart } from './night-rules';

describe('desde dónde cuenta el Z y desde cuándo busca ajustes', () => {
  const opened = new Date('2026-10-14T20:00:00Z');

  it('primera noche: desde que se abrió', () => {
    expect(zStart(null, opened)).toEqual({ from: opened, since: opened });
  });

  it('desde el cierre de la anterior; ajustes desde que se generó su Z (cerrada sola a las 08:00, Z a las 08:10)', () => {
    const closedAt = new Date('2026-10-14T06:00:00Z');
    const z = { generatedAt: '2026-10-14T06:10:00.000Z' };
    expect(zStart({ closedAt, zReport: z }, opened)).toEqual({ from: closedAt, since: new Date('2026-10-14T06:10:00Z') });
  });

  it('Z anterior sin hora válida → ajustes desde su cierre', () => {
    const closedAt = new Date('2026-10-14T06:00:00Z');
    expect(zStart({ closedAt, zReport: null }, opened).since).toEqual(closedAt);
    expect(zStart({ closedAt, zReport: { generatedAt: 'basura' } }, opened).since).toEqual(closedAt);
    expect(zStart({ closedAt, zReport: { generatedAt: '2026-10-13T00:00:00Z' } }, opened).since).toEqual(closedAt);
  });
});

describe('ajustes de noches anteriores', () => {
  const before = new Date('2026-10-14T06:00:00Z');
  const since = new Date('2026-10-14T06:10:00Z');
  const lateCobro = {
    id: 'p-late', paidAt: new Date('2026-10-14T03:59:00Z'), status: 'AUTHORIZED', amountCents: 5000, tipCents: 0,
    revenueCategory: 'VENUE_BAR', captureMethod: 'QR', serviceName: null, payMethod: null, payMethodCode: null,
    cardBrand: null, cardType: null, cardCountry: null, authCode: null, providerTxId: 'X', walletId: null,
    creatorName: null, creatorEmail: 'barra@local.es', earningOperatorName: null, earningOperatorEmail: null,
    refundedCents: 0, commissionCents: null, earningTipCents: null, reversedCents: null, reversedAfterPayoutCents: 0,
  } as CobroRow;
  const backdatedRefund = {
    id: 'r-late', refundedAt: new Date('2026-10-10T12:00:00Z'), amountCents: 2000, reason: null, providerRefundId: null,
    registeredManually: true, byName: null, byEmail: 'owner@local.es', paymentId: 'p-old', paidAt: new Date('2026-10-09T22:00:00Z'),
    providerTxId: 'Y', chargedCents: 2000, creatorName: null, creatorEmail: null, chicaName: 'Lola', chicaEmail: 'lola@local.es',
    reversedDeltaCents: 1800, afterPayout: true,
  } as DevolucionRow;
  const reversedConsumption = {
    id: 'c-late', at: new Date('2026-10-14T02:00:00Z'), amountCents: 3000, tipCents: 500, category: 'CHICA_SERVICE',
    operatorName: 'Ana', operatorEmail: 'ana@local.es', commissionCents: 2700, earningTipCents: 500,
  } as ConsumoRow;

  it('cobro pagado tarde, devolución con fecha atrás y consumo anulado después: van al Z siguiente', () => {
    const a = buildAdjustments({
      before,
      since,
      rows: { cobros: [lateCobro], devoluciones: [backdatedRefund], consumosAnulados: [reversedConsumption] },
    });
    expect(a).toMatchObject({
      before: '2026-10-14T06:00:00.000Z',
      since: '2026-10-14T06:10:00.000Z',
      count: 3,
      reversedConsumptionsCount: 1,
      reversedConsumptionsCents: 3500,
      reversedConsumptionsChicaCents: 3200,
    });
    expect(a.summary).toMatchObject({ count: 1, chargedCents: 5000, refundsCents: 2000, netCents: 3000, chicaReversalsCents: 1800 });
  });

  it('sin nada apuntado tarde → ceros', () => {
    const a = buildAdjustments({ before, since, rows: { cobros: [], devoluciones: [], consumosAnulados: [] } });
    expect(a.count).toBe(0);
    expect(a.summary.netCents).toBe(0);
  });
});

describe('la caja en el Z', () => {
  const cash: NightCash = {
    openingFloatCents: 20_000,
    cashInCents: 0,
    walletCashPayoutsCount: 1,
    walletCashPayoutsCents: 3000,
    chicaCashPayoutsCount: 1,
    chicaCashPayoutsCents: 9000,
    cashOutCents: 12_000,
    expectedCents: 8000,
  };
  const now = new Date('2026-10-14T02:30:00Z');
  const window = { from: new Date('2026-10-13T20:00:00Z'), to: now };

  it('contada con diferencia: esperado, contado, diferencia, nota y hora', () => {
    const caja = buildNightCaja(cash, evaluateCash(cash, { countedCents: 6750 }), '  faltan monedas ', now);
    expect(caja).toEqual({
      openingFloatCents: 20_000,
      // El fondo apuntado al abrir (aquí, el mismo).
      recordedFloatCents: 20_000,
      cashInCents: 0,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 3000,
      chicaCashPayoutsCount: 1,
      chicaCashPayoutsCents: 9000,
      // Los camareros, aparte (aquí, ninguno): así se sabe que lo de arriba es solo de las chicas.
      camareroCashPayoutsCount: 0,
      camareroCashPayoutsCents: 0,
      cashOutCents: 12_000,
      expectedCents: 8000,
      countedCents: 6750,
      diffCents: -1250,
      note: 'faltan monedas',
      frozenAt: now.toISOString(),
    });
  });

  it('sin contar (cierre automático): lo que debería haber, sin contado ni diferencia', () => {
    // Sin lo contado, un «primer recuento» suelto no va al Z.
    expect(buildNightCaja(cash, evaluateCash(cash), null, now, 5000)).not.toHaveProperty('firstCountedCents');
    expect(buildNightCaja(cash, evaluateCash(cash, { countedCents: 6750 }), null, now, 5000)).toMatchObject({ countedCents: 6750, firstCountedCents: 5000 });
    expect(buildNightCaja(cash, evaluateCash(cash, { countedCents: 6750 }), null, now)).not.toHaveProperty('firstCountedCents');
    const caja = buildNightCaja(cash, evaluateCash(cash), null, now);
    expect(caja).toMatchObject({ expectedCents: 8000, countedCents: null, diffCents: null, note: null });
  });

  it('el Z la lleva al cerrar; el de una noche abierta (o de antes) no tiene el campo', () => {
    const summary = summarize([], [], []);
    const caja = buildNightCaja(cash, evaluateCash(cash, { countedCents: 8000 }), null, now);
    expect(buildNightZ(window, summary, 0, now, undefined, caja).caja).toMatchObject({ diffCents: 0 });
    expect('caja' in buildNightZ(window, summary, 0, now)).toBe(false);
  });
});

describe('cierre automático a las 08:00', () => {
  const opened = new Date('2026-10-13T20:00:00Z'); // 22:00 de Madrid

  it('antes de las 08:00 sigue abierta', () => {
    expect(autoCloseAt(opened, new Date('2026-10-14T05:59:00Z'))).toBeNull();
  });

  it('a partir de las 08:00 se cierra, con hora de cierre las 08:00', () => {
    expect(autoCloseAt(opened, new Date('2026-10-14T09:30:00Z'))?.toISOString()).toBe('2026-10-14T06:00:00.000Z');
  });
});

describe('cobros sin terminar al cerrar (pagos #9)', () => {
  it('también las recargas de la recepción que el datáfono ya mandó al lector (/start) y siguen en vigor', () => {
    const sql = unresolvedPaymentsWhere('t-1', { from: new Date(0), to: new Date() }).sql;
    expect(sql).toContain(`"captureMethod" = 'POS_EXTERNAL'`);
    expect(sql).toContain(`"captureMethod" = 'WALLET_TOPUP'`);
    expect(sql).toContain(`e."paymentId" = payments.id AND e."eventType" = 'pos.device_started'`);
    expect(sql).toContain(`status IN ('AUTHORIZING', 'ORPHAN')`);
  });
});

describe('el efectivo de la noche sale de las filas del Z', () => {
  const at = new Date('2026-10-13T21:00:00Z');
  const liquidacion = (totalCents: number, externalRail: string) => ({
    id: `po-${totalCents}`, paidAt: at, totalCents, externalRail, externalTxId: null, reconciliationStatus: 'PENDING',
    notes: null, operatorName: null, operatorEmail: 'lola@local.es', paidByName: null, paidByEmail: null, earningCount: 1,
  });

  it('recargas (con su anulación restando), saldo devuelto en efectivo y pagos en efectivo a las chicas', () => {
    const cash = cashFromRows(10_000, {
      recargasEfectivo: [
        { id: 'r1', at, amountCents: 5000, takenByName: null, takenByEmail: null, terminalLabel: null },
        { id: 'r2', at, amountCents: 99_999, takenByName: null, takenByEmail: null, terminalLabel: null },
        { id: 'v2', at, amountCents: -99_999, voidOfId: 'r2', takenByName: null, takenByEmail: null, terminalLabel: null },
      ],
      pagosSaldo: [
        { id: 'p1', at, amountCents: 2000, method: 'CASH', paidByName: null, paidByEmail: null },
        { id: 'p2', at, amountCents: 7000, method: 'CARD', paidByName: null, paidByEmail: null },
      ],
      liquidaciones: [liquidacion(1500, 'MANUAL_CASH'), liquidacion(4000, 'BIZUM')],
    });
    expect(cash).toEqual({
      openingFloatCents: 10_000,
      cashInCents: 5000,
      walletCashTopUpsCount: 1,
      walletCashTopUpsCents: 5000,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 2000,
      chicaCashPayoutsCount: 1,
      chicaCashPayoutsCents: 1500,
      camareroCashPayoutsCount: 0,
      camareroCashPayoutsCents: 0,
      cashOutCents: 3500,
      expectedCents: 11_500,
    });
  });

  it('los pagos en efectivo a los camareros van aparte de los de las chicas (lo que sale, lo mismo)', () => {
    const cash = cashFromRows(10_000, {
      recargasEfectivo: [],
      pagosSaldo: [],
      liquidaciones: [
        { ...liquidacion(751, 'MANUAL_CASH'), id: 'po-lola', role: 'OPERATOR' },
        { ...liquidacion(750, 'MANUAL_CASH'), id: 'po-dani', role: 'WAITER', operatorEmail: 'dani@local.es' },
        // Sin el puesto (filas de antes): una chica.
        { ...liquidacion(100, 'MANUAL_CASH'), id: 'po-old' },
        { ...liquidacion(900, 'BIZUM'), id: 'po-bizum', role: 'WAITER' },
      ],
    });
    expect(cash).toMatchObject({
      chicaCashPayoutsCount: 2,
      chicaCashPayoutsCents: 851,
      camareroCashPayoutsCount: 1,
      camareroCashPayoutsCents: 750,
      cashOutCents: 1601,
      expectedCents: 10_000 - 1601,
    });
    const caja = buildNightCaja(cash, evaluateCash(cash), null, at);
    expect(caja).toMatchObject({ chicaCashPayoutsCount: 2, chicaCashPayoutsCents: 851, camareroCashPayoutsCount: 1, camareroCashPayoutsCents: 750 });
  });
});
