import { describe, it, expect } from 'vitest';
import {
  ACKABLE_KINDS,
  SELF_RESOLVING,
  ackKey,
  approvalPendingIncident,
  backupIncidents,
  bankMismatchIncident,
  duplicateChargeIncident,
  nightClosedPendingIncident,
  openIncidents,
  paymentAnomalyIncident,
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
    expect(morningSummaryMessage('Local Centro', summary, 0, true)).toContain(
      'Cuadre con el banco: sube el fichero de ayer (panel → Banco)',
    );
    expect(morningSummaryMessage('Local Centro', summary, 0)).not.toContain('Cuadre con el banco');
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

  it('la diferencia de caja al cerrar, solo si la hay', () => {
    expect(morningSummaryMessage('Local Centro', summary, 0, false, -1250)).toContain(
      'Caja: faltan 12,50 € al cerrar (panel → Noches)',
    );
    expect(morningSummaryMessage('Local Centro', summary, 0, false, 500)).toContain('Caja: sobran 5,00 €');
    expect(morningSummaryMessage('Local Centro', summary, 0, false, 0)).not.toContain('Caja');
    expect(morningSummaryMessage('Local Centro', summary, 0, false, null)).not.toContain('Caja');
  });
});

describe('avisos de cobro aprobado que no se dieron por buenos', () => {
  const row = (eventType: string, payload: Record<string, unknown>) => ({
    id: '501',
    eventType,
    paymentId: 'p-9',
    amountCents: 10_500,
    occurredAt: at('2026-10-14T23:00:00Z'),
    payload,
  });

  it('sin comprobar (Peanpe): dónde mirarlo; se quita sola al resolver el cobro (uno por cobro)', () => {
    const i = paymentAnomalyIncident(
      row('payment.approval_unverified', { provider: 'PEANPE', providerTxId: 'ABC123', reason: 'peanpe-sin-consulta' }),
    );
    expect(i).toMatchObject({ kind: 'approval_unverified', refId: 'p-9', ackable: false, paymentId: 'p-9' });
    expect(SELF_RESOLVING.has('approval_unverified')).toBe(true);
    expect(i.detail).toContain('Peanpe avisa de que el cliente pagó 105,00 €');
    expect(i.detail).toContain('el panel de Peanpe (pedido ABC123)');
    expect(i.detail).toContain('Pagos → Resolver');
  });

  it('importe distinto: los dos importes, y se marca como revisada', () => {
    const i = paymentAnomalyIncident(
      row('payment.amount_mismatch', {
        provider: 'REDSYS',
        providerTxId: '1234ABCD',
        chargedCents: 100,
        chargedCurrency: 'EUR',
        expectedCents: 10_500,
      }),
    );
    expect(i).toMatchObject({ kind: 'amount_mismatch', refId: '501', ackable: true, amountCents: 100 });
    expect(i.detail).toContain('Aprobado 1,00 € · el cobro era de 105,00 € (pedido 1234ABCD)');
    expect(i.detail).toContain('el portal del banco');
  });

  it('aprobación de un cobro caducado: devolverlo', () => {
    const i = paymentAnomalyIncident(
      row('payment.approval_unbooked', { provider: 'REDSYS', providerTxId: '1234ABCD', fromStatus: 'EXPIRED' }),
    );
    expect(i).toMatchObject({ kind: 'approval_unbooked', ackable: true, title: 'El banco cobró un pago que aquí no se pudo apuntar' });
    expect(i.detail).toBe(
      '105,00 €. El cobro estaba caducado cuando llegó la aprobación (pedido 1234ABCD). Devuélveselo al cliente desde el portal del banco.',
    );
  });
});

describe('qué se puede marcar como revisada', () => {
  it('toda incidencia marcable sale en ACKABLE_KINDS (las del banco y copias incluidas) y ninguna se quita sola', () => {
    const bank = bankMismatchIncident({
      id: 'bi-1',
      status: 'NOT_IN_BANK',
      kind: 'SALE',
      source: 'REDSYS',
      bankAmountCents: null,
      oursAmountCents: 6000,
      reference: '2610MLbhyfNg',
      authCode: null,
      paymentId: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
      operationAt: at('2026-10-13T21:18:59Z'),
      occurredAt: at('2026-10-13T21:18:59Z'),
    });
    const [unmonitored] = backupIncidents({ kind: 'unmonitored' } as never, at('2026-10-14T09:00:00Z'), true);
    for (const i of [bank, unmonitored!]) {
      expect(i.ackable).toBe(true);
      expect(ACKABLE_KINDS as readonly string[]).toContain(i.kind);
    }
    // La clave de las diferencias con el banco pasa de 64 caracteres.
    expect(bank.refId.length).toBeGreaterThan(64);
    for (const kind of ACKABLE_KINDS) expect(SELF_RESOLVING.has(kind)).toBe(false);
  });
});

describe('«Por aprobar» sin decidir', () => {
  const now = at('2026-10-16T03:40:00Z');
  const row = { id: 'ap-1', amountCents: 14_000, requestedAt: at('2026-10-16T03:00:00Z'), requester: 'Ana', operatorName: 'Lola' };

  it('pago: quién pidió qué y hace cuánto; se quita sola al decidirla (no se marca)', () => {
    const i = approvalPendingIncident({ ...row, kind: 'PAYOUT' }, now);
    expect(i).toMatchObject({ kind: 'approval_pending', refId: 'ap-1', ackable: false, amountCents: 14_000, paymentId: null });
    expect(i.title).toBe('Pago a una chica por aprobar');
    expect(i.detail).toBe('Ana pidió pagar 140,00 € a Lola hace 40 min. Apruébalo o recházalo en «Por aprobar»: caduca a las 24 h.');
    expect(SELF_RESOLVING.has('approval_pending')).toBe(true);
    expect((ACKABLE_KINDS as readonly string[]).includes('approval_pending')).toBe(false);
  });

  it('devolución', () => {
    const i = approvalPendingIncident({ ...row, kind: 'REFUND', operatorName: null, requester: null }, now);
    expect(i.title).toBe('Devolución por aprobar');
    expect(i.detail).toMatch(/^El encargado pidió devolver 140,00 € hace 40 min/);
  });
});
