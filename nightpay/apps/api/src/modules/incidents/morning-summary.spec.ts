import { describe, it, expect } from 'vitest';
import type { ExportSummary } from '../reports/export-csv';
import { mergeSummaries } from './morning-summary';

/** Dos cierres en el mismo tramo de 08:00 a 08:00: el resumen suma sus dos Z. */
const base = (o: Partial<ExportSummary>): ExportSummary => ({
  count: 0,
  grossCents: 0,
  tipsCents: 0,
  chargedCents: 0,
  refundsCount: 0,
  refundsCents: 0,
  netCents: 0,
  byType: [],
  chicaCommissionCents: 0,
  chicaTipsCents: 0,
  chicaReversalsCents: 0,
  chicaNetCents: 0,
  venueTipsCents: 0,
  venueNetCents: 0,
  payoutsCount: 0,
  payoutsCents: 0,
  perChica: [],
  walletCashPayoutsCount: 0,
  walletCashPayoutsCents: 0,
  walletCardPayoutsCount: 0,
  walletCardPayoutsCents: 0,
  consumptionsCount: 0,
  consumptionsCents: 0,
  saldoByType: [],
  ...o,
});
const chica = (name: string, netCents: number) => ({
  name,
  count: 1,
  chargedCents: netCents,
  commissionCents: netCents,
  tipsCents: 0,
  reversalsCents: 0,
  netCents,
  paidCents: 0,
});

describe('mergeSummaries', () => {
  it('una sola: tal cual', () => {
    const s = base({ count: 3, chargedCents: 900 });
    expect(mergeSummaries([s])).toBe(s);
  });

  it('suma cifras, tipos y chicas (la misma chica en las dos, una vez)', () => {
    const a = base({
      count: 2,
      grossCents: 2000,
      chargedCents: 2000,
      walletCashTopUpsCount: 1,
      walletCashTopUpsCents: 500,
      byType: [{ label: 'Barra', count: 2, chargedCents: 2000 }],
      perChica: [chica('Lola', 800)],
      chicaNetCents: 800,
    });
    const b = base({
      count: 1,
      grossCents: 1000,
      chargedCents: 1000,
      walletCashTopUpsCount: 0,
      walletCashTopUpsCents: 0,
      byType: [
        { label: 'Barra', count: 1, chargedCents: 1000 },
        { label: 'Sala', count: 1, chargedCents: 300 },
      ],
      perChica: [chica('Lola', 200), chica('Ana', 100)],
      chicaNetCents: 300,
    });
    const m = mergeSummaries([a, b]);
    expect(m).toMatchObject({
      count: 3,
      grossCents: 3000,
      chargedCents: 3000,
      chicaNetCents: 1100,
      walletCashTopUpsCount: 1,
      walletCashTopUpsCents: 500,
    });
    expect(m.byType).toEqual([
      { label: 'Barra', count: 3, chargedCents: 3000 },
      { label: 'Sala', count: 1, chargedCents: 300 },
    ]);
    expect(m.perChica.map((c) => [c.name, c.netCents])).toEqual([
      ['Lola', 1000],
      ['Ana', 100],
    ]);
  });

  it('un Z antiguo sin un campo: el campo queda sin poner (no se inventa un 0 que no cuadre)', () => {
    const viejo = base({ count: 1 });
    const nuevo = base({ count: 1, walletCardTopUpsCount: 1, walletCardTopUpsCents: 100 });
    const m = mergeSummaries([viejo, nuevo]);
    expect(m.walletCardTopUpsCents).toBeUndefined();
    expect(m.count).toBe(2);
  });
});
