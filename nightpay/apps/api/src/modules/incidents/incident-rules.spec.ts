import { describe, it, expect } from 'vitest';
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

  it('lo de los camareros (su parte de las copas con invitación) va en el reparto si no es 0: chicas + camareros + local = neto', () => {
    // Noche con 15,01 € cobrados: Lola 7,51 €, Dani (camarero) 7,50 €, el local 0 €.
    const night = { ...summary, count: 1, grossCents: 1501, tipsCents: 0, chargedCents: 1501, refundsCount: 0, refundsCents: 0, netCents: 1501, chicaNetCents: 751, camareroNetCents: 750, venueNetCents: 0 };
    expect(morningSummaryMessage('Local Centro', night, 0)).toContain('Para las chicas: 7,51 € · para los camareros: 7,50 € · para el local: 0,00 €');
    // La noche siguiente se devuelven 7,50 €: a cada uno lo suyo, en negativo.
    const next = { ...night, chargedCents: 0, grossCents: 0, refundsCount: 1, refundsCents: 750, netCents: -750, chicaNetCents: -375, camareroNetCents: -375, venueNetCents: 0 };
    expect(morningSummaryMessage('Local Centro', next, 0)).toContain('Para las chicas: -3,75 € · para los camareros: -3,75 € · para el local: 0,00 €');
    // Sin nada para los camareros (lo normal), como siempre.
    expect(morningSummaryMessage('Local Centro', { ...summary, camareroNetCents: 0 }, 0)).toContain('Para las chicas: 920,00 € · para el local: 200,00 €');
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
