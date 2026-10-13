import { describe, it, expect } from 'vitest';
import {
  ackKey,
  duplicateChargeIncident,
  nightClosedPendingIncident,
  openIncidents,
  stuckIncident,
} from './incident-rules';
import { incidentMessage, morningSummaryMessage } from './alert-messages';
import type { ExportSummary } from '../reports/export-csv';

const at = (iso: string) => new Date(iso);

describe('incidencias', () => {
  const stuck = stuckIncident({ id: 'p-1', status: 'AUTHORIZING', amountCents: 10_000, updatedAt: at('2026-10-13T22:00:00Z') });
  const orphan = stuckIncident({ id: 'p-2', status: 'ORPHAN', amountCents: 500, updatedAt: at('2026-10-13T21:00:00Z') });
  const dup = duplicateChargeIncident({
    id: '77',
    paymentId: 'p-3',
    amountCents: 10_500,
    occurredAt: at('2026-10-13T23:00:00Z'),
    payload: { order: '1234ABCD5678' },
  });
  const night = nightClosedPendingIncident({
    id: 'n-1',
    closedAt: at('2026-10-14T06:00:00Z'),
    pendingAtClose: 2,
    autoClosed: true,
  });

  it('cobro atascado: se resuelve en Pagos, no se marca como revisado', () => {
    expect(stuck).toMatchObject({ kind: 'stuck_payment', ackable: false, paymentId: 'p-1' });
    expect(orphan.title).toContain('sin confirmar');
  });

  it('doble cobro: dice qué pedido devolver', () => {
    expect(dup).toMatchObject({ kind: 'duplicate_charge', ackable: true, paymentId: 'p-3' });
    expect(dup.detail).toContain('1234ABCD5678');
  });

  it('las revisadas desaparecen; los atascados no se pueden ocultar; las más recientes primero', () => {
    const acked = new Set([ackKey('duplicate_charge', '77'), ackKey('stuck_payment', 'p-1')]);
    expect(openIncidents([stuck, orphan, dup, night], acked).map((i) => i.refId)).toEqual(['n-1', 'p-1', 'p-2']);
  });

  it('mensaje de Telegram corto con el local y qué hacer', () => {
    expect(incidentMessage('Local Centro', night)).toBe(
      '⚠️ Local Centro: La noche se cerró sola con cobros sin resolver\n2 cobros quedaron pendientes. Resuélvelos en Pagos.',
    );
  });
});

describe('resumen de las 9:00', () => {
  const summary: ExportSummary = {
    count: 12,
    grossCents: 120_000,
    tipsCents: 2000,
    chargedCents: 122_000,
    refundsCount: 1,
    refundsCents: 10_000,
    netCents: 112_000,
    byType: [],
    chicaCommissionCents: 99_000,
    chicaTipsCents: 2000,
    chicaReversalsCents: 9000,
    chicaNetCents: 92_000,
    venueTipsCents: 0,
    venueNetCents: 20_000,
    payoutsCount: 0,
    payoutsCents: 0,
    perChica: [
      { name: 'Lola', count: 7, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversalsCents: 0, netCents: 60_000, paidCents: 0 },
      { name: 'Ana', count: 5, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversalsCents: 0, netCents: 32_000, paidCents: 0 },
    ],
  };

  it('cobros, propinas, devoluciones, reparto, chicas e incidencias', () => {
    expect(morningSummaryMessage('Local Centro', summary, 1)).toBe(
      [
        '☀️ Local Centro — anoche',
        '12 cobros · cobrado 1220,00 €',
        'Propinas: 20,00 €',
        'Devoluciones: −100,00 €',
        'Para las chicas: 920,00 € · para el local: 200,00 €',
        'Chicas que cobraron: 2 (detalle en el panel → Noches)',
        'Incidencias por mirar: 1 (panel → Incidencias)',
      ].join('\n'),
    );
  });
});
