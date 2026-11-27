import { describe, expect, it } from 'vitest';
import { summarize } from '../reports/export-csv';
import type { CobroRow, RecargaEfectivoRow } from '../reports/export-rows';
import { MAX_NIGHT_HOURS, nightHourly } from './night-hourly';

/**
 * Lo pagado de la noche abierta, hora a hora (el minigráfico del Resumen):
 * lo mismo que suma «Pagado esta noche» (summarize.chargedCents), repartido
 * por la hora de cada cobro y de cada recarga en efectivo.
 */

// Las 01:30 de Madrid (23:30 UTC): la hora de ahora es la de las 23:00 UTC.
const NOW = new Date('2026-10-13T23:30:00Z');

function cobro(paidAt: string, amountCents: number, o: Partial<CobroRow> = {}): CobroRow {
  return {
    id: `c-${paidAt}-${amountCents}`,
    paidAt: new Date(paidAt),
    status: 'AUTHORIZED',
    amountCents,
    tipCents: 0,
    revenueCategory: 'VENUE_BAR',
    lines: null,
    captureMethod: 'QR',
    walletId: null,
    creatorName: 'Paula',
    creatorEmail: 'paula@local.es',
    earningOperatorName: null,
    earningOperatorEmail: null,
    refundedCents: 0,
    commissionCents: null,
    earningTipCents: null,
    reversedCents: null,
    reversedAfterPayoutCents: 0,
    ...o,
  } as CobroRow;
}

function recarga(at: string, amountCents: number, o: Partial<RecargaEfectivoRow> = {}): RecargaEfectivoRow {
  return { id: `r-${at}-${amountCents}`, at: new Date(at), amountCents, takenByName: 'Javi', takenByEmail: 'javi@local.es', terminalLabel: null, ...o };
}

const cents = (hours: ReturnType<typeof nightHourly>) => hours.map((h) => h.chargedCents);

describe('lo pagado por horas de la noche abierta', () => {
  it('suma lo mismo que «Pagado esta noche»: importe + propina + comisión, y las recargas en efectivo con su comisión', () => {
    const cobros = [
      cobro('2026-10-13T20:10:00Z', 1_000, { tipCents: 200, serviceFeeCents: 50 }),
      cobro('2026-10-13T21:40:00Z', 4_000, { walletId: 'w-1' }),
      cobro('2026-10-13T23:05:00Z', 900),
    ];
    const recargasEfectivo = [recarga('2026-10-13T21:15:00Z', 5_000, { serviceFeeCents: 25 })];
    const hours = nightHourly({ cobros, recargasEfectivo }, NOW);
    const total = summarize(cobros, [], [], [], [], recargasEfectivo).chargedCents;
    expect(hours.reduce((s, h) => s + h.chargedCents, 0)).toBe(total);
    expect(cents(hours)).toEqual([1_250, 9_025, 0, 900]);
  });

  it('las horas sin nada, a 0; seguidas desde la primera con movimiento hasta la de ahora, en UTC', () => {
    const hours = nightHourly({ cobros: [cobro('2026-10-13T20:59:59Z', 500)], recargasEfectivo: [] }, NOW);
    expect(hours.map((h) => h.at)).toEqual([
      '2026-10-13T20:00:00.000Z',
      '2026-10-13T21:00:00.000Z',
      '2026-10-13T22:00:00.000Z',
      '2026-10-13T23:00:00.000Z',
    ]);
    expect(cents(hours)).toEqual([500, 0, 0, 0]);
  });

  it('solo la hora de ahora va abierta', () => {
    const hours = nightHourly({ cobros: [cobro('2026-10-13T22:30:00Z', 500)], recargasEfectivo: [] }, NOW);
    expect(hours.map((h) => h.open)).toEqual([false, true]);
  });

  it('una recarga en efectivo anulada resta en su hora (con su comisión)', () => {
    const hours = nightHourly(
      {
        cobros: [],
        recargasEfectivo: [
          recarga('2026-10-13T22:05:00Z', 5_000, { serviceFeeCents: 25 }),
          recarga('2026-10-13T23:10:00Z', -5_000, { serviceFeeCents: -25, voidOfId: 'r-1' }),
        ],
      },
      NOW,
    );
    expect(cents(hours)).toEqual([5_025, -5_025]);
  });

  it('sin movimiento, ninguna hora', () => {
    expect(nightHourly({ cobros: [], recargasEfectivo: [] }, NOW)).toEqual([]);
  });

  it('como mucho 24 horas (las últimas)', () => {
    const hours = nightHourly({ cobros: [cobro('2026-10-11T20:00:00Z', 100)], recargasEfectivo: [] }, NOW);
    expect(MAX_NIGHT_HOURS).toBe(24);
    expect(hours).toHaveLength(24);
    expect(hours[0]!.at).toBe('2026-10-13T00:00:00.000Z');
    expect(hours.at(-1)).toEqual({ at: '2026-10-13T23:00:00.000Z', chargedCents: 0, open: true });
  });
});
