import { describe, it, expect } from 'vitest';
import { evaluateCash, withCashInput, type NightCash } from '@nightpay/contracts';
import { morningSummaryMessage } from '../incidents/alert-messages';
import { efectivoStep } from '../nights/close-check-rules';
import { buildNightCaja } from '../nights/night-rules';
import { resumenCsv, summarize } from './export-csv';
import type { PagoSaldoRow, RecargaEfectivoRow } from './export-rows';
import { CASH_TOP_UP_LABEL } from './export-summary';

/**
 * La recarga del saldo en efectivo en los informes: cuenta como cobrada al
 * cargarla (igual que la de tarjeta; el IVA va con la recarga y los consumos
 * del saldo no se facturan otra vez), va aparte de los cobros del banco y es
 * efectivo que ENTRA en la caja de la noche (fondo + entradas − salidas).
 */

const AT = new Date('2026-10-21T00:30:00Z');
const recarga = (id: string, amountCents: number): RecargaEfectivoRow => ({
  id, at: AT, amountCents, takenByName: 'Javi', takenByEmail: 'javi@bambu.es', terminalLabel: null,
});
const devolucionEfectivo: PagoSaldoRow = { id: 'wp-1', at: AT, amountCents: 2_000, method: 'CASH', paidByName: null, paidByEmail: 'javi@bambu.es' };

describe('resumen (Z de la noche, gestoría y aviso de la mañana)', () => {
  it('cobrado y neto incluyen la recarga en efectivo; no es un cobro del banco (count) y sale por tipo', () => {
    const s = summarize([], [], [], [], [devolucionEfectivo], [recarga('ct-1', 5_000), recarga('ct-2', 3_000)]);
    expect(s).toMatchObject({
      count: 0,
      grossCents: 0,
      chargedCents: 8_000,
      walletCashTopUpsCount: 2,
      walletCashTopUpsCents: 8_000,
      walletCashPayoutsCents: 2_000,
      netCents: 6_000,
      // Sin chicas: es del local.
      venueNetCents: 6_000,
    });
    expect(s.byType).toEqual([{ label: CASH_TOP_UP_LABEL, count: 2, chargedCents: 8_000 }]);
  });

  it('sin recargas en efectivo, todo igual que antes (y el tipo no sale)', () => {
    const s = summarize([], [], []);
    expect(s).toMatchObject({ chargedCents: 0, netCents: 0, walletCashTopUpsCount: 0, walletCashTopUpsCents: 0 });
    expect(s.byType).toEqual([]);
  });

  it('el CSV de la gestoría lo dice en su línea', () => {
    const csv = resumenCsv({
      venueName: 'Sala Bambú',
      period: { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') } as never,
      generatedAt: AT,
      summary: summarize([], [], [], [], [], [recarga('ct-1', 5_000)]),
    });
    expect(csv).toMatch(/Recargas del saldo en efectivo;50,00;1/);
    expect(csv).toMatch(/Total cobrado;50,00/);
    expect(csv).toMatch(/con tarjeta o en efectivo/);
  });

  it('el aviso de las 9:00 dice las recargas en efectivo (en la caja)', () => {
    const s = summarize([], [], [], [], [], [recarga('ct-1', 5_000)]);
    expect(morningSummaryMessage('Sala Bambú', s, 0)).toContain('Recargas en efectivo: 1 · 50,00 € (en la caja)');
    expect(morningSummaryMessage('Sala Bambú', summarize([], [], []), 0)).not.toContain('Recargas en efectivo');
  });
});

const CASH: NightCash = {
  openingFloatCents: 10_000,
  cashInCents: 8_000,
  walletCashTopUpsCount: 2,
  walletCashTopUpsCents: 8_000,
  walletCashPayoutsCount: 1,
  walletCashPayoutsCents: 2_000,
  chicaCashPayoutsCount: 0,
  chicaCashPayoutsCents: 0,
  cashOutCents: 2_000,
  expectedCents: 16_000,
};

describe('caja de la noche: el efectivo de las recargas entra', () => {
  it('esperado = fondo + recargas en efectivo − salidas; contado igual → cuadra', () => {
    expect(evaluateCash(CASH, { countedCents: 16_000 })).toMatchObject({ expectedCents: 16_000, diffCents: 0, status: 'ok' });
    expect(evaluateCash(CASH, { countedCents: 15_000 })).toMatchObject({ diffCents: -1_000, status: 'warn', reason: 'short' });
  });

  it('solo entró efectivo y nadie dijo el fondo: bloquea con lo que entró', () => {
    const onlyIn: NightCash = { ...CASH, openingFloatCents: null, walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, cashOutCents: 0 };
    expect(evaluateCash(onlyIn)).toMatchObject({ status: 'block', reason: 'float-missing' });
    expect(evaluateCash(onlyIn).detail).toMatch(/^Entraron 80,00 € en efectivo/);
    expect(evaluateCash({ ...CASH, openingFloatCents: null }).detail).toMatch(/^Entraron 80,00 € y salieron 20,00 € en efectivo/);
  });

  it('el paso «Efectivo» lista las recargas (en positivo) y las cuenta', () => {
    const step = efectivoStep(CASH);
    expect(step.items[0]).toEqual({ id: 'wallet-cash-topups', status: 'ok', label: 'Recargas del saldo en efectivo: 2 recargas', amountCents: 8_000 });
    expect(step.count).toBe(3);
    expect(withCashInput([step], CASH, { countedCents: 16_000 })[0]).toMatchObject({ status: 'ok', count: 3 });
  });

  it('el bloque «Caja» del Z congela las recargas en efectivo', () => {
    const caja = buildNightCaja(CASH, evaluateCash(CASH, { countedCents: 16_000 }), null, AT);
    expect(caja).toMatchObject({ cashInCents: 8_000, walletCashTopUpsCount: 2, walletCashTopUpsCents: 8_000, expectedCents: 16_000, diffCents: 0 });
  });
});
