import { SENSITIVE_AUDIT_ACTIONS, sensitiveActionIncident } from './incident-rules';
import { describe, it, expect } from 'vitest';
import { Z_NET_LABEL, Z_NET_WITHOUT_STAFF_LABEL } from '@nightpay/contracts';
import {
  ACKABLE_KINDS,
  SELF_RESOLVING,
  ackKey,
  approvalPendingIncident,
  backupIncidents,
  bankMismatchIncident,
  cashSplitIncident,
  duplicateChargeIncident,
  earningReverseFailedIncident,
  nightClosedPendingIncident,
  openIncidents,
  paymentAnomalyIncident,
  posVoidedPaidIncident,
  receptionPayoutCapIncident,
  stuckIncident,
  walletCardLostIncident,
  walletCloseRequestedIncident,
  walletCreditSkippedIncident,
  walletOpenBalanceIncident,
} from './incident-rules';
import { incidentMessage, morningSummaryMessage } from './alert-messages';
import type { ExportSummary } from '../reports/export-csv';

const at = (iso: string) => new Date(iso);

describe('acciones delicadas: el dueño tiene que poder verlas', () => {
  const row = (action: string, o: Record<string, unknown> = {}) => ({ id: 'a1', action, paymentId: 'p1', amountCents: 5_000, occurredAt: new Date(), payload: null, actorName: 'Javi', ...o });

  it('dice quién en el panel y no en Telegram; se quita marcándola como revisada', () => {
    const i = sensitiveActionIncident(row('wallet.charge_without_faceid'));
    expect(i).toMatchObject({ kind: 'sensitive_action', refId: 'a1', amountCents: 5_000, ackable: true, paymentId: null, title: 'Cobro sin que el cliente confirme' });
    expect(i.detail).toContain('Javi ha cobrado');
    expect(i.alertDetail).not.toContain('Javi');
    expect(i.alertDetail).toContain('Alguien del personal ha cobrado');
    expect(ACKABLE_KINDS as readonly string[]).toContain('sensitive_action');
    expect(SELF_RESOLVING.has('sensitive_action')).toBe(false);
  });

  it('sin persona (lo hizo el cliente, o no se sabe): no se inventa un nombre', () => {
    expect(sensitiveActionIncident(row('wallet.card_copy_suspected', { actorName: null })).detail).toMatch(/^Han acercado/);
    expect(sensitiveActionIncident(row('wallet.relinked', { actorName: null })).detail).toMatch(/^Alguien del personal ha dado/);
  });

  it('baja con dinero sin cobrar: el nombre en el panel, no en Telegram', () => {
    const i = sensitiveActionIncident(row('operator.left_with_balance', { payload: { name: 'Lola' }, actorName: null, amountCents: 12_000 }));
    expect(i.detail).toContain('(Lola)');
    expect(i.alertDetail).not.toContain('Lola');
    expect(i.amountCents).toBe(12_000);
  });

  it('el cobro dado por pagado a mano lleva a su cobro', () => {
    expect(sensitiveActionIncident(row('payment.manual_reconcile')).paymentId).toBe('p1');
  });

  it('todas las que vigila tienen su texto', () => {
    expect(SENSITIVE_AUDIT_ACTIONS).toEqual(expect.arrayContaining(['wallet.merged_large', 'wallet.activation_not_new', 'wallet.pin_reset', 'venue.night_settings.updated']));
    for (const a of SENSITIVE_AUDIT_ACTIONS) expect(sensitiveActionIncident(row(a)).title).not.toBe('Acción delicada');
  });
});

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
        '☀️ Local Centro — anoche: de las 08:00 de ayer a las 08:00 de hoy (sin noche cerrada)',
        // Un Z de antes del 23-oct no trae las recargas con tarjeta aparte: sin desglose (no cuadraría).
        'Cobrado: 1220,00 €',
        'Con tarjeta: 12 pagos · 1220,00 €',
        'Propinas: 20,00 €',
        'Devoluciones: −100,00 €',
        'Para las chicas: 920,00 € · neto sin el personal: 200,00 €',
        'Chicas que cobraron: 2 (detalle en el panel → Noches)',
        'Incidencias por mirar: 1 (panel → Incidencias)',
      ].join('\n'),
    );
  });

  it('lo de los camareros (su parte de las copas con invitación) va en el reparto si no es 0: chicas + camareros + local = neto', () => {
    // Noche con 15,01 € cobrados: Lola 7,51 €, Dani (camarero) 7,50 €, el local 0 €.
    const night = { ...summary, count: 1, grossCents: 1501, tipsCents: 0, chargedCents: 1501, refundsCount: 0, refundsCents: 0, netCents: 1501, chicaNetCents: 751, camareroNetCents: 750, venueNetCents: 0 };
    expect(morningSummaryMessage('Local Centro', night, 0)).toContain('Para las chicas: 7,51 € · para los camareros: 7,50 € · neto sin el personal: 0,00 €');
    // La noche siguiente se devuelven 7,50 €: a cada uno lo suyo, en negativo.
    const next = { ...night, chargedCents: 0, grossCents: 0, refundsCount: 1, refundsCents: 750, netCents: -750, chicaNetCents: -375, camareroNetCents: -375, venueNetCents: 0 };
    expect(morningSummaryMessage('Local Centro', next, 0)).toContain('Para las chicas: -3,75 € · para los camareros: -3,75 € · neto sin el personal: 0,00 €');
    // Sin nada para los camareros (lo normal), como siempre.
    expect(morningSummaryMessage('Local Centro', { ...summary, camareroNetCents: 0 }, 0)).toContain('Para las chicas: 920,00 € · neto sin el personal: 200,00 €');
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

describe('resumen de las 9:00: las cifras dicen lo que cuentan', () => {
  // La noche de la demo: 9 ventas con tarjeta (533 €) y 2 recargas con tarjeta (100 €) = 11 pagos con
  // tarjeta; 26 € de propinas y 6 recargas en efectivo (450 €) → cobrado 1109 €.
  const demo: ExportSummary = {
    count: 11,
    grossCents: 63_300,
    tipsCents: 2_600,
    chargedCents: 110_900,
    refundsCount: 1,
    refundsCents: 1_200,
    netCents: 110_900 - 1_200 - 2_000,
    walletCashTopUpsCount: 6,
    walletCashTopUpsCents: 45_000,
    walletCardTopUpsCount: 2,
    walletCardTopUpsCents: 10_000,
    byType: [],
    chicaCommissionCents: 7_800,
    chicaTipsCents: 1_500,
    chicaReversalsCents: 0,
    chicaNetCents: 9_300,
    venueTipsCents: 1_100,
    venueNetCents: 107_700 - 9_300,
    payoutsCount: 0,
    payoutsCents: 0,
    perChica: [],
    walletCashPayoutsCount: 1,
    walletCashPayoutsCents: 2_000,
    walletCardPayoutsCount: 0,
    walletCardPayoutsCents: 0,
    consumptionsCount: 11,
    consumptionsCents: 34_300,
    saldoByType: [],
  };

  it('«cobrado» como en el panel (ventas + propinas + recargas, con el desglose) y lo de la tarjeta aparte: lo que verá en el banco (DIN-3)', () => {
    const text = morningSummaryMessage('Sala Aurora', demo, 0);
    // Antes: «11 pagos con tarjeta · cobrado 1109,00 €», y 450 € eran efectivo.
    expect(text).not.toContain('11 pagos con tarjeta · cobrado 1109,00 €');
    expect(text).toContain('Cobrado: 1109,00 € (533,00 € de ventas con tarjeta + 26,00 € de propinas con tarjeta + 550,00 € de recargas)');
    // 9 ventas y 2 recargas con tarjeta (633 €) + 26 € de propinas.
    expect(text).toContain('Con tarjeta: 11 pagos · 659,00 €');
    // Las propinas ya van en el desglose de «Cobrado».
    expect(text).not.toContain('Propinas:');
  });

  it('«11 pagos con tarjeta» (no «cobros»: los del saldo no van ahí), las dos recargas y el neto sin el personal (no «para el local»)', () => {
    const text = morningSummaryMessage('Sala Aurora', demo, 0);
    expect(text).toContain('Con tarjeta: 11 pagos');
    expect(text).toContain('Recargas con tarjeta: 2 · 100,00 €');
    expect(text).toContain('Recargas en efectivo: 6 · 450,00 € (en la caja)');
    expect(text).toContain('Para las chicas: 93,00 € · neto sin el personal: 984,00 €');
    expect(text).not.toContain('para el local');
  });

  it('el neto del resumen se llama como en el panel y no como el otro neto del Z (prueba real: «neto 1.733 €» frente a «neto sin el personal 1.626 €»)', () => {
    const text = morningSummaryMessage('Sala Aurora', demo, 0);
    expect(text).toContain(`${Z_NET_WITHOUT_STAFF_LABEL.toLowerCase()}: 984,00 €`);
    // Ningún otro «neto» suelto que se confunda con «Neto (cobrado − devuelto)» del Z.
    expect(text.split(Z_NET_WITHOUT_STAFF_LABEL.toLowerCase()).join('')).not.toMatch(/neto/i);
    expect(Z_NET_WITHOUT_STAFF_LABEL).not.toBe(Z_NET_LABEL);
  });
});

describe('resumen de las 9:00: qué tramo resume (DIN-4)', () => {
  const s: ExportSummary = {
    count: 1, grossCents: 1000, tipsCents: 0, chargedCents: 1000, refundsCount: 0, refundsCents: 0, netCents: 1000,
    walletCardTopUpsCount: 0, walletCardTopUpsCents: 0, walletCashTopUpsCount: 0, walletCashTopUpsCents: 0,
    byType: [], chicaCommissionCents: 0, chicaTipsCents: 0, chicaReversalsCents: 0, chicaNetCents: 0,
    venueTipsCents: 0, venueNetCents: 1000, payoutsCount: 0, payoutsCents: 0, perChica: [],
    walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, walletCardPayoutsCount: 0, walletCardPayoutsCents: 0,
    consumptionsCount: 0, consumptionsCents: 0, saldoByType: [],
  };
  const first = (scope: Parameters<typeof morningSummaryMessage>[5]) =>
    morningSummaryMessage('Sala Aurora', s, 0, false, null, scope).split('\n')[0];

  it('la noche cerrada a mano: su Z, con la hora del cierre (Madrid)', () => {
    expect(first({ kind: 'nights', nights: [{ closedAt: new Date('2026-10-14T03:00:00Z'), autoClosed: false }] })).toBe(
      '☀️ Sala Aurora — anoche: el Z de la noche cerrada a las 05:00',
    );
  });

  it('la que se cerró sola a las 08:00', () => {
    expect(first({ kind: 'nights', nights: [{ closedAt: new Date('2026-10-14T06:00:00Z'), autoClosed: true }] })).toBe(
      '☀️ Sala Aurora — anoche: el Z de la noche, cerrada sola a las 08:00',
    );
  });

  it('dos cierres en el mismo tramo: los dos Z sumados, y lo dice', () => {
    expect(
      first({
        kind: 'nights',
        nights: [
          { closedAt: new Date('2026-10-13T21:40:00Z'), autoClosed: false },
          { closedAt: new Date('2026-10-14T03:00:00Z'), autoClosed: false },
        ],
      }),
    ).toBe('☀️ Sala Aurora — anoche: los Z de 2 noches cerradas (a las 23:40 y a las 05:00)');
  });

  it('sin noche cerrada: de 08:00 a 08:00, y que no es un Z', () => {
    expect(first({ kind: 'window' })).toBe(
      '☀️ Sala Aurora — anoche: de las 08:00 de ayer a las 08:00 de hoy (sin noche cerrada)',
    );
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

  it('cobro único: pagado con el saldo y la tarjeta aprobada después → «cobrado dos veces», devolver la tarjeta', () => {
    const i = paymentAnomalyIncident(
      row('payment.approval_unbooked', {
        provider: 'REDSYS',
        providerTxId: '9876WXYZ',
        fromStatus: 'CANCELED',
        reason: 'paid_with_saldo',
        amountCents: 2_000,
      }),
    );
    expect(i).toMatchObject({ kind: 'approval_unbooked', ackable: true, amountCents: 2_000, title: 'Cobrado dos veces: con el saldo y con la tarjeta' });
    expect(i.detail).toContain('(pedido 9876WXYZ)');
    expect(i.detail).toContain('Devuélvele 20,00 € a la tarjeta desde el portal del banco');
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
    const voided = posVoidedPaidIncident({ id: 'e-1', paymentId: 'p-1', amountCents: null, occurredAt: at('2026-10-13T21:00:00Z'), payload: {} });
    expect(voided.detail).toMatch(/^El cliente no ha pagado/);
    for (const i of [bank, unmonitored!, voided]) {
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

describe('efectivo troceado en saldos nuevos', () => {
  it('sale en la bandeja, se marca como revisada y dice cuántos saldos', () => {
    const i = cashSplitIncident({
      id: 'audit-1', paymentId: null, amountCents: 120_000, occurredAt: new Date('2026-10-21T01:00:00Z'), payload: { count: 2 },
    });
    expect(i).toMatchObject({ kind: 'cash_split_suspected', refId: 'audit-1', amountCents: 120_000, ackable: true, paymentId: null });
    expect(i.detail).toMatch(/^2 saldos nuevos en efectivo/);
    expect(ACKABLE_KINDS as readonly string[]).toContain('cash_split_suspected');
  });

  it('recepción pasa su tope de la noche: con su nombre en el panel y sin él en Telegram; se marca como revisada', () => {
    const i = receptionPayoutCapIncident({
      id: '91', paymentId: 'u-1', amountCents: 5_000, occurredAt: at('2026-10-23T03:00:00Z'), actorName: 'Sergio',
      payload: { nightPaidCents: 26_000, nightCapCents: 30_000 },
    });
    expect(i).toMatchObject({ kind: 'reception_payout_cap', refId: '91', ackable: true, amountCents: 5_000 });
    expect(i.detail).toBe('Sergio quería devolver 50,00 € (ya llevaba 260,00 € devueltos y su tope es 300,00 €). Desde ahí, cada salida la confirma el encargado con su 2FA. Revisa sus salidas de esta noche (Clientes → Saldos).');
    expect(i.alertDetail).not.toContain('Sergio');
    expect(ACKABLE_KINDS).toContain('reception_payout_cap');
    expect(incidentMessage('Luna', i)).not.toContain('Sergio');
  });
});

describe('descuento a la chica que el repaso no consigue hacer', () => {
  const row = (payload: unknown) => ({ id: 'ae-1', paymentId: 'p-1', amountCents: 1500, occurredAt: at('2026-10-15T10:00:00Z'), payload });

  it('dice cuántas veces lo intentó el repaso y por qué falla (para que lo arregle una persona)', () => {
    const inc = earningReverseFailedIncident(row({ attempts: 5, error: 'earning no encontrado para el cobro', source: 'sweep' }));
    expect(inc).toMatchObject({ kind: 'earning_reverse_failed', paymentId: 'p-1', amountCents: 1500, ackable: true });
    expect(inc.detail).toContain('5 veces');
    expect(inc.detail).toContain('Motivo: earning no encontrado para el cobro');
  });

  it('el aviso de la devolución en el momento (sin intentos) sigue como antes', () => {
    expect(earningReverseFailedIncident(row({ error: '' })).detail).toBe(
      'Revisa su saldo en Operadoras: la devolución está hecha pero su comisión no se ha descontado.',
    );
  });
});

describe('«He perdido mi NFC»', () => {
  it('sale en la bandeja del local que dio el NFC, se marca como revisada y a Telegram va sin el código', () => {
    const i = walletCardLostIncident({
      id: 'audit-9', paymentId: null, amountCents: 3_000, occurredAt: new Date('2026-10-27T01:06:00Z'), payload: { code: 'K7Q-4M2', cards: 1, via: 'client_passkey' },
    });
    expect(i).toMatchObject({ kind: 'wallet_card_lost', refId: 'audit-9', amountCents: 3_000, ackable: true, paymentId: null, title: 'Un cliente ha bloqueado su NFC' });
    expect(i.detail).toContain('Su saldo K7Q-4M2 (30,00 €) sigue valiendo con su código y PIN o su Face ID');
    expect(i.detail).toContain('dale un NFC nuevo');
    expect(i.alertDetail).not.toContain('K7Q');
    expect(incidentMessage('Sala', i)).not.toContain('K7Q');
    expect(ACKABLE_KINDS as readonly string[]).toContain('wallet_card_lost');
    expect(SELF_RESOLVING.has('wallet_card_lost')).toBe(false);
    const bare = walletCardLostIncident({ id: 'a', paymentId: null, amountCents: null, occurredAt: new Date(), payload: null });
    expect(bare.detail).toContain('Su saldo sigue valiendo');
  });
});

describe('avisos del saldo: «Saldos» (nunca «Wallets») y el código con guion', () => {
  const row = { id: 'w-1', shortCode: 'UYSJ5G', balanceCents: 2_900, occurredAt: new Date('2026-10-22T16:29:00Z') };

  it('un cliente pide su saldo: dónde se devuelve y su código como lo ve él (UYS-J5G)', () => {
    const i = walletCloseRequestedIncident(row);
    expect(i.title).toBe('Un cliente pide que le devuelvan su saldo');
    expect(i.detail).toBe('29,00 € · código UYS-J5G. Devuélveselo en Clientes → Saldos → Devolver saldo (tarjeta o efectivo).');
    // Telegram lleva el mismo texto.
    expect(incidentMessage('Sala Aurora', i)).toContain('código UYS-J5G. Devuélveselo en Clientes → Saldos');
    expect(walletCloseRequestedIncident({ ...row, shortCode: null }).detail).toBe(
      '29,00 €. Devuélveselo en Clientes → Saldos → Devolver saldo (tarjeta o efectivo).',
    );
  });

  it('saldo sin devolver tras cerrar: también con el código con guion y «Saldos»', () => {
    expect(walletOpenBalanceIncident(row).detail).toBe(
      '29,00 € · código UYS-J5G. Si el cliente ya se fue, devuélveselo a la tarjeta en Clientes → Saldos → Devolver saldo.',
    );
  });

  it('recarga cobrada que no llegó al saldo: sin «wallet»', () => {
    const i = walletCreditSkippedIncident({ id: 'e-1', paymentId: 'p-1', amountCents: 1_000, occurredAt: row.occurredAt, payload: null });
    expect(i.title).toBe('Recarga cobrada que no llegó al saldo');
    expect(i.detail).toBe('El cliente pagó pero su saldo no estaba activo. Devuélvelo en BBVA o reactiva el saldo.');
    for (const text of [i.title, i.detail, walletCloseRequestedIncident(row).detail, walletOpenBalanceIncident(row).detail]) {
      expect(text).not.toMatch(/wallet/i);
      expect(text).not.toMatch(/código [A-Z0-9]{6}\b/);
    }
  });
});

describe('resumen de las 9:00 con la «Comisión del servicio»', () => {
  // 33 € + 3,30 € + 2 € con tarjeta; recarga en efectivo 50 € + 6 €; nada devuelto.
  const s: ExportSummary = {
    count: 1, grossCents: 3300, tipsCents: 200, chargedCents: 3300 + 200 + 5000 + 930, refundsCount: 0, refundsCents: 0,
    netCents: 3300 + 200 + 5000 + 930,
    walletCardTopUpsCount: 0, walletCardTopUpsCents: 0, walletCashTopUpsCount: 1, walletCashTopUpsCents: 5000,
    serviceFeeCents: 930, serviceFeeCashCents: 600, serviceFeeRefundedCents: 0, serviceFeeNetCents: 930,
    byType: [], chicaCommissionCents: 2970, chicaTipsCents: 200, chicaReversalsCents: 0, chicaNetCents: 3170,
    venueTipsCents: 0, venueNetCents: 3300 + 200 + 5000 + 930 - 3170 - 930, payoutsCount: 0, payoutsCents: 0, perChica: [],
    walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, walletCardPayoutsCount: 0, walletCardPayoutsCents: 0,
    consumptionsCount: 0, consumptionsCents: 0, saldoByType: [],
  };

  it('lo cobrado la desglosa, la tarjeta la incluye y se dice lo que se debe a OxioPay (aparte de lo del local)', () => {
    const text = morningSummaryMessage('Sala Aurora', s, 0);
    expect(text).toContain('Cobrado: 94,30 € (33,00 € de ventas con tarjeta + 2,00 € de propinas con tarjeta + 50,00 € de recargas + 9,30 € de comisión del servicio)');
    expect(text).toContain('Con tarjeta: 1 pago · 38,30 €');
    expect(text).toContain('Comisión del servicio: 9,30 € (se debe a OxioPay; 6,00 € en la caja)');
    expect(text).toContain('Para las chicas: 31,70 € · neto sin el personal ni OxioPay: 53,30 €');
  });

  it('sin ella, el de siempre', () => {
    const plain = { ...s, serviceFeeCents: 0, serviceFeeCashCents: 0, serviceFeeNetCents: 0 };
    expect(morningSummaryMessage('Sala Aurora', plain, 0)).not.toContain('omisión del servicio');
    expect(morningSummaryMessage('Sala Aurora', plain, 0)).toContain('neto sin el personal:');
  });
});
