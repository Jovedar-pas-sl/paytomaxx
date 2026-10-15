import { describe, it, expect } from 'vitest';
import type { CobroRow, ConsumoRow, DevolucionRow } from '../reports/export-rows';
import { autoCloseAt, buildAdjustments, decideClose, zStart } from './night-rules';

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

describe('cerrar la noche', () => {
  it('sin cobros pendientes → se cierra', () => {
    expect(decideClose({ pendingCount: 0, force: false, role: 'MANAGER', note: undefined })).toEqual({ ok: true });
  });

  it('con cobros sin resolver → no se cierra', () => {
    expect(decideClose({ pendingCount: 2, force: false, role: 'OWNER', note: undefined })).toEqual({
      ok: false,
      reason: 'pending',
    });
  });

  it('cerrar igualmente: solo el dueño y con nota', () => {
    expect(decideClose({ pendingCount: 2, force: true, role: 'MANAGER', note: 'lo miro mañana' })).toEqual({
      ok: false,
      reason: 'force-owner-only',
    });
    expect(decideClose({ pendingCount: 2, force: true, role: 'OWNER', note: ' ' })).toEqual({
      ok: false,
      reason: 'note-required',
    });
    expect(decideClose({ pendingCount: 2, force: true, role: 'OWNER', note: 'BBVA lo confirma mañana' })).toEqual({
      ok: true,
    });
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
