import { SENSITIVE_AUDIT_ACTIONS, sensitiveActionIncident } from './incident-rules';
import { describe, it, expect } from 'vitest';
import { Z_NET_LABEL, Z_NET_WITHOUT_STAFF_LABEL, alertKindForIncident } from '@nightpay/contracts';
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
  serviceDisputedIncident,
  stuckIncident,
  walletCardLostIncident,
  walletChargeDisputedIncident,
  ackNeedsNote,
  walletCloseRequestedIncident,
  walletCreditSkippedIncident,
} from './incident-rules';
import * as rules from './incident-rules';
import { incidentMessage, morningSummaryMessage } from './alert-messages';
import { bitcoinSummary, cardPaymentsCount } from '../reports/export-summary';
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

  it('desbloquear el PIN de un cliente sale como borrarlo: quién en el panel, no en Telegram', () => {
    const i = sensitiveActionIncident(row('wallet.pin_unlocked', { amountCents: null }));
    expect(i).toMatchObject({ kind: 'sensitive_action', title: 'PIN de un cliente desbloqueado', ackable: true });
    expect(i.detail).toMatch(/^Javi ha desbloqueado el PIN de un saldo/);
    expect(i.alertDetail).toMatch(/^Alguien del personal ha desbloqueado/);
    // Con el código del saldo en el panel; a Telegram, sin él.
    const coded = sensitiveActionIncident(row('wallet.pin_unlocked', { amountCents: null, payload: { code: '5NX-9P4' } }));
    expect(coded.detail).toMatch(/^Javi ha desbloqueado el PIN de un saldo .*\(saldo 5NX-9P4\)$/);
    expect(coded.alertDetail).not.toContain('5NX');
    expect(i.detail).not.toContain('(saldo');
  });

  it('cuenta de cobro cambiada: quién y a quién en el panel, sin nombres ni cuenta en Telegram', () => {
    const payload = { via: 'panel', name: 'Lola', after: { payoutAddress: 'ES91 •••• •••• 1332' } };
    const panel = sensitiveActionIncident(row('operator.payout_account_changed', { payload, amountCents: null }));
    expect(panel).toMatchObject({ kind: 'sensitive_action', title: 'Cuenta de cobro cambiada', ackable: true, paymentId: null });
    expect(panel.detail).toMatch(/^Javi ha cambiado la cuenta de cobro de una compañera/);
    expect(panel.detail).toContain('(Lola)');
    expect(panel.alertDetail).toMatch(/^Alguien del personal ha cambiado la cuenta de cobro/);
    expect(panel.alertDetail).not.toContain('Lola');
    expect(panel.alertDetail).not.toContain('1332');
  });

  it('cuenta de cobro: por el enlace de alta o por OxioPay, otro texto; el titular que no se parece, avisado', () => {
    const link = sensitiveActionIncident(row('operator.payout_account_changed', { payload: { via: 'enlace', name: 'Lola' }, actorName: 'Lola' }));
    expect(link.title).toBe('Cuenta de cobro puesta con el enlace de alta');
    expect(link.detail).toMatch(/^Una compañera ha puesto su cuenta de cobro/);
    const support = sensitiveActionIncident(row('operator.payout_account_changed', { payload: { via: 'oxiopay', name: 'Lola' }, actorName: 'Soporte' }));
    expect(support.title).toBe('OxioPay ha cambiado una cuenta de cobro');
    expect(support.detail).not.toContain('Soporte');
    const mismatch = sensitiveActionIncident(row('operator.payout_account_changed', { payload: { via: 'panel', name: 'Lola', holderMismatch: true } }));
    expect(mismatch.detail).toContain('El titular no se parece a su nombre');
    expect(mismatch.alertDetail).toContain('El titular no se parece a su nombre');
  });

  it('cuenta de cobro sin el correo activado (emailed: false): no promete el email, tampoco en Telegram', () => {
    const changed = (payload: Record<string, unknown>) => sensitiveActionIncident(row('operator.payout_account_changed', { payload }));
    const panel = changed({ via: 'panel', name: 'Lola', emailed: false });
    expect(panel.detail).toBe('Javi ha cambiado la cuenta de cobro de una compañera, con su 2FA. Le hemos avisado en su app. (Lola)');
    expect(panel.alertDetail).toBe('Alguien del personal ha cambiado la cuenta de cobro de una compañera, con su 2FA. Le hemos avisado en su app.');
    expect(changed({ via: 'enlace', name: 'Lola', emailed: false }).detail).toBe(
      'Una compañera ha puesto su cuenta de cobro con su enlace de alta: comprueba que es suya antes de pagarle. (Lola)',
    );
    expect(changed({ via: 'oxiopay', emailed: false }).alertDetail).toBe(
      'OxioPay ha cambiado la cuenta de cobro de una compañera (el motivo está en el registro). Le hemos avisado en su app.',
    );
    // Con el correo, o un registro de antes sin el campo: el texto de siempre.
    expect(changed({ via: 'panel', emailed: true }).detail).toContain('Le hemos avisado por email y en su app.');
    expect(changed({ via: 'enlace' }).detail).toContain('Le hemos avisado por email');
  });

  it('todas las que vigila tienen su texto', () => {
    expect(SENSITIVE_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['wallet.merged_large', 'wallet.activation_not_new', 'wallet.pin_reset', 'wallet.pin_unlocked', 'venue.night_settings.updated', 'operator.payout_account_changed']),
    );
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

  it('cobro atascado: se resuelve en Hoy → Cobros, no se marca como revisado', () => {
    expect(stuck).toMatchObject({ kind: 'stuck_payment', ackable: false, paymentId: 'p-1' });
    expect(orphan.title).toContain('sin confirmar');
  });

  it('cobro con bitcoin atascado: su factura en BTCPay, sin hablar del banco ni de BBVA', () => {
    const btc = stuckIncident({ id: 'p-9', status: 'AUTHORIZING', amountCents: 3_000, updatedAt: at('2026-10-13T22:00:00Z'), provider: 'BTCPAY' });
    expect(btc).toMatchObject({ kind: 'stuck_payment', ackable: false, paymentId: 'p-9', title: 'Cobro con bitcoin sin terminar' });
    expect(btc.detail).toContain('factura en tu BTCPay');
    expect(btc.detail).toContain('id de la factura');
    expect(`${btc.title} ${btc.detail}`).not.toMatch(/banco|BBVA/);
    expect(stuck.detail).toContain('BBVA');
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
      '⚠️ Local Centro: La noche se cerró sola con cobros sin resolver\n2 cobros quedaron pendientes. Resuélvelos en Hoy → Cobros.',
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
        'Cobrado: 1.220,00 €',
        'Con tarjeta: 12 pagos · 1.220,00 €',
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
    expect(text).not.toContain('11 pagos con tarjeta · cobrado 1.109,00 €');
    expect(text).toContain('Cobrado: 1.109,00 € (533,00 € de ventas con tarjeta + 26,00 € de propinas con tarjeta + 550,00 € de recargas)');
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

describe('resumen de las 9:00 con bitcoin: aparte, en la cartera del local (nunca «con tarjeta»)', () => {
  it('de 11 pagos, 1 venta de 40 € + 2 € de propina y 1 recarga de 50 € con bitcoin: salen de «Con tarjeta» y de «Recargas con tarjeta»', () => {
    const base: ExportSummary = {
      count: 11, grossCents: 63_300, tipsCents: 2_600, chargedCents: 110_900, refundsCount: 0, refundsCents: 0, netCents: 110_900,
      walletCashTopUpsCount: 6, walletCashTopUpsCents: 45_000, walletCardTopUpsCount: 2, walletCardTopUpsCents: 10_000, byType: [],
      chicaCommissionCents: 0, chicaTipsCents: 0, chicaReversalsCents: 0, chicaNetCents: 0, venueTipsCents: 2_600, venueNetCents: 110_900,
      payoutsCount: 0, payoutsCents: 0, perChica: [], walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, walletCardPayoutsCount: 0,
      walletCardPayoutsCents: 0, consumptionsCount: 0, consumptionsCents: 0, saldoByType: [],
      bitcoin: { count: 2, salesCents: 4_000, tipsCents: 200, topUpsCount: 1, topUpsCents: 5_000, serviceFeeCents: 0, totalCents: 9_200 },
    };
    const text = morningSummaryMessage('Sala Aurora', base, 0);
    expect(text).toContain('Cobrado: 1.109,00 € (493,00 € de ventas con tarjeta + 24,00 € de propinas con tarjeta + 42,00 € de ventas y propinas con bitcoin + 550,00 € de recargas)');
    expect(text).toContain('Con tarjeta: 9 pagos · 567,00 €');
    expect(text).toContain('Bitcoin: 2 pagos · 92,00 €, en la cartera del local');
    expect(text).toContain('Recargas con tarjeta: 1 · 50,00 €');
  });

  it('el resumen cuenta el bitcoin por el intento que cobró (ventas, propinas, recargas y su comisión)', () => {
    const row = (o: Record<string, unknown>) => ({ payMethod: 'card', walletId: null, amountCents: 1_000, tipCents: 0, serviceFeeCents: 0, ...o }) as never;
    expect(bitcoinSummary([row({})])).toBeNull();
    expect(
      bitcoinSummary([row({}), row({ payMethod: 'bitcoin', tipCents: 100, serviceFeeCents: 50 }), row({ payMethod: 'bitcoin', walletId: 'w', amountCents: 5_000, serviceFeeCents: 300 })]),
    ).toEqual({ count: 2, salesCents: 1_000, tipsCents: 100, topUpsCount: 1, topUpsCents: 5_000, serviceFeeCents: 350, totalCents: 6_450 });
    expect(cardPaymentsCount({ count: 5, bitcoin: { count: 2 } as never })).toBe(3);
    expect(cardPaymentsCount({ count: 5 })).toBe(5);
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
    expect(i.detail).toContain('Hoy → Cobros → Resolver');
  });

  it('bitcoin: pago a medias o tardío = incidencia que NO da por pagado, con dónde mirarlo', () => {
    const partial = paymentAnomalyIncident(
      row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV1', reason: 'btcpay-paid_partial', source: 'btcpay' }),
    );
    expect(partial).toMatchObject({ kind: 'approval_unverified', ackable: false, title: 'Pago de bitcoin a medias' });
    expect(partial.detail).toContain('NO se ha dado por pagado');
    expect(partial.detail).toContain('Míralo en tu BTCPay');
    expect(partial.detail).not.toMatch(/banco/);
    const late = paymentAnomalyIncident(
      row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV1', reason: 'btcpay-paid_late', source: 'btcpay' }),
    );
    expect(late.title).toBe('Pago de bitcoin fuera de plazo');
    const marked = paymentAnomalyIncident(
      row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV1', reason: 'btcpay-marked', source: 'btcpay' }),
    );
    expect(marked.detail).toContain('Marcada como pagada a mano en BTCPay: compruébalo antes de darla por buena.');
    expect(marked.detail).toContain('NO se ha dado por pagado');
    const mismatch = paymentAnomalyIncident(
      row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV1', reason: 'btcpay-amount_mismatch', source: 'btcpay' }),
    );
    expect(mismatch.title).toBe('Una factura de bitcoin no cuadra con el cobro');
  });

  it('bitcoin llegado a un cobro cancelado: devolverlo desde la cartera del local', () => {
    const i = paymentAnomalyIncident(row('payment.approval_unbooked', { provider: 'BTCPAY', providerTxId: 'INV1', fromStatus: 'CANCELED' }));
    expect(i).toMatchObject({ kind: 'approval_unbooked', ackable: true });
    expect(i.detail).toContain('cancelado');
    expect(i.detail).toContain('cartera del local');
    expect(`${i.title} ${i.detail}`).not.toMatch(/banco/i);
  });

  it('bitcoin llegado a un cobro que ya se pagó con tarjeta: «ya pagado de otra forma», no «cerrado»', () => {
    for (const fromStatus of ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']) {
      const i = paymentAnomalyIncident(row('payment.approval_unbooked', { provider: 'BTCPAY', providerTxId: 'INV1', fromStatus, paidWith: 'REDSYS' }));
      expect(i).toMatchObject({ kind: 'approval_unbooked', ackable: true });
      expect(i.title).toBe('El cliente pagó dos veces: también con bitcoin');
      expect(i.detail).toContain('cuando el cobro ya estaba pagado de otra forma (factura INV1)');
      expect(i.detail).toContain('cartera del local');
    }
  });

  it('bitcoin: enseña lo que LLEGÓ; con el cobro ya cerrado, aviso de dinero con nota y «Devolver en efectivo»', () => {
    const closed = paymentAnomalyIncident({
      ...row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV9', reason: 'btcpay-paid_late', source: 'btcpay', paidCents: 2_500 }),
      paymentStatus: 'EXPIRED',
    });
    expect(closed).toMatchObject({ kind: 'approval_unbooked', ackable: true, amountCents: 2_500, cashReturn: { invoiceId: 'INV9', maxCents: 2_500 } });
    expect(closed.detail).toContain('caducado');
    expect(closed.detail).toContain('Llegaron 25,00 €');
    // A medias con el cobro aún esperando: lo recibido, «Resolver», y también se puede devolver.
    const waiting = paymentAnomalyIncident({
      ...row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV8', reason: 'btcpay-paid_partial', source: 'btcpay', paidCents: 1_000 }),
      paymentStatus: 'AUTHORIZING',
    });
    expect(waiting).toMatchObject({ kind: 'approval_unverified', ackable: false, amountCents: 1_000, cashReturn: { invoiceId: 'INV8', maxCents: 1_000 } });
    // Sin saber cuánto llegó, o marcada a mano: sin botón de devolver.
    expect(paymentAnomalyIncident(row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV7', reason: 'btcpay-paid_partial', source: 'btcpay' })).cashReturn).toBeUndefined();
    expect(paymentAnomalyIncident(row('payment.approval_unverified', { provider: 'BTCPAY', providerTxId: 'INV6', reason: 'btcpay-marked', source: 'btcpay', paidCents: 900 })).cashReturn).toBeUndefined();
  });

  it('bitcoin pagado de más: solo un aviso para el cuadre (se cierra con nota), sin devolver', () => {
    const i = paymentAnomalyIncident(
      row('payment.bitcoin_overpaid', { provider: 'BTCPAY', providerTxId: 'INV5', reason: 'btcpay-paid_over', source: 'btcpay', amountCents: 3_000, paidCents: 3_250, extraCents: 250 }),
    );
    expect(i).toMatchObject({ kind: 'bitcoin_overpaid', ackable: true, amountCents: 250, title: 'Pago de bitcoin de más' });
    expect(i.detail).toContain('2,50 € de más');
    expect(i.detail).toContain('no se devuelve');
    expect(i.cashReturn).toBeUndefined();
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

describe('una devolución hecha en el banco sin apuntar', () => {
  it('de una recarga: no manda a «Devolver saldo» (el saldo no se devuelve) y no dice «chica»', () => {
    const i = bankMismatchIncident({
      id: 'bi-2', status: 'REFUND_NOT_IN_OXIOPAY', kind: 'REFUND', source: 'REDSYS', bankAmountCents: 5000, oursAmountCents: null,
      reference: '2610REFUND01', authCode: null, paymentId: null, operationAt: at('2026-10-13T21:18:59Z'), occurredAt: at('2026-10-13T21:18:59Z'),
    });
    expect(i.detail).toContain('Si es de una recarga, el saldo no se devuelve');
    expect(i.detail).not.toMatch(/Devolver saldo|\bchica\b/);
    expect(i.detail).toContain('la parte de la compañera');
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

describe('«No he sido yo» (aviso en cada cobro)', () => {
  it('sale en la bandeja del local del cobro, pide nota para cerrarse y a Telegram va sin el código', () => {
    const i = walletChargeDisputedIncident({
      id: 'audit-11', paymentId: 'charge-1', amountCents: 1_200, occurredAt: new Date('2026-11-17T00:10:00Z'),
      payload: { ref: 'C-0042', code: 'K7Q-4M2', cards: 1, pinLocked: true, via: 'push_not_me' },
    });
    expect(i).toMatchObject({ kind: 'wallet_charge_disputed', refId: 'audit-11', amountCents: 1_200, ackable: true, paymentId: null, title: 'Un cliente dice que no ha sido él' });
    expect(i.detail).toContain('El cliente dice que no ha sido él: cobro C-0042 de 12,00 € (saldo K7Q-4M2)');
    expect(i.detail).toContain('si procede, devuélvelo');
    expect(i.alertDetail).not.toContain('K7Q');
    expect(incidentMessage('Sala', i)).not.toContain('K7Q');
    expect(ACKABLE_KINDS as readonly string[]).toContain('wallet_charge_disputed');
    expect(SELF_RESOLVING.has('wallet_charge_disputed')).toBe(false);
    expect(ackNeedsNote({ kind: 'wallet_charge_disputed', amountCents: 1_200 })).toBe(true);
  });

  it('un saldo sin Face ID: no dice que con él sigue pagando (los avisos de antes, sin el campo, como siempre)', () => {
    const base = { id: 'audit-12', paymentId: 'charge-2', amountCents: 1_200, occurredAt: new Date('2026-11-20T00:10:00Z') };
    const sin = walletChargeDisputedIncident({ ...base, payload: { ref: 'C-0043', code: 'K7Q-4M2', faceId: false } });
    for (const text of [sin.detail, sin.alertDetail]) {
      expect(text).toContain('Su ficha y su PIN ya no pagan. Revisa el cobro');
      expect(text).not.toContain('Face ID');
    }
    const con = walletChargeDisputedIncident({ ...base, payload: { ref: 'C-0043', faceId: true } });
    expect(con.detail).toContain('Su ficha y su PIN ya no pagan (con su Face ID, sí).');
    expect(walletChargeDisputedIncident({ ...base, payload: { ref: 'C-0043' } }).alertDetail).toContain('(con su Face ID, sí)');
  });
});

describe('«No es mío»: una compañera dice que un servicio cobrado a su nombre no es suyo', () => {
  const base = { id: 'audit-21', paymentId: 'earning-1', amountCents: 6_000, occurredAt: new Date('2026-11-26T00:30:00Z') };
  const payload = {
    ref: 'C-0123',
    amountCents: 6_000,
    shareCents: 5_400,
    paymentId: 'pay-1',
    chargedById: 'u-carlos',
    chargedByName: 'Carlos',
    operatorName: 'Nerea',
  };

  it('el detalle lleva los nombres; a Telegram va sin ellos; es de cobros y se cierra con nota', () => {
    const i = serviceDisputedIncident({ ...base, payload });
    expect(i).toMatchObject({
      kind: 'service_disputed',
      refId: 'audit-21',
      amountCents: 6_000,
      paymentId: 'pay-1',
      ackable: true,
      title: 'Una compañera dice que un servicio no es suyo',
    });
    const todo =
      'Habla con quien lo cobró; si era de otra compañera, devuélvelo y cóbralo otra vez a su nombre (si ya se le pagó, se le descuenta del siguiente pago).';
    expect(i.detail).toBe(`Nerea dice que el cobro C-0123 de 60,00 € (su parte, 54,00 €) no es suyo. Lo cobró Carlos. ${todo}`);
    expect(i.alertDetail).toBe(`Una compañera dice que el cobro C-0123 de 60,00 € (su parte, 54,00 €) no es suyo. ${todo}`);
    for (const name of ['Nerea', 'Carlos']) expect(incidentMessage('Sala', i)).not.toContain(name);
    expect(incidentMessage('Sala', i, { includeNames: true })).toContain('Lo cobró Carlos.');
    expect(ACKABLE_KINDS as readonly string[]).toContain('service_disputed');
    expect(SELF_RESOLVING.has('service_disputed')).toBe(false);
    expect(ackNeedsNote({ kind: 'service_disputed', amountCents: 6_000 })).toBe(true);
    expect(alertKindForIncident('service_disputed')).toBe('payments');
  });

  it('del saldo (sin cobro con tarjeta) y sin nombres: sin «Abrir cobro» y con «Una compañera»', () => {
    const i = serviceDisputedIncident({ ...base, payload: { ...payload, paymentId: null, chargedByName: null, operatorName: null } });
    expect(i.paymentId).toBeNull();
    expect(i.detail).toMatch(/^Una compañera dice que el cobro C-0123 de 60,00 € \(su parte, 54,00 €\) no es suyo\. Habla con quien lo cobró;/);
  });
});

describe('avisos del saldo: «Saldos» (nunca «Wallets») y el código con guion', () => {
  const row = { id: 'w-1', shortCode: 'UYSJ5G', balanceCents: 2_900, occurredAt: new Date('2026-10-22T16:29:00Z') };

  it('una devolución pedida antes de la nueva regla: dónde se termina y su código como lo ve él (UYS-J5G)', () => {
    const i = walletCloseRequestedIncident(row);
    expect(i.title).toBe('Devolución de saldo pedida antes de la nueva regla');
    expect(i.detail).toBe('29,00 € · código UYS-J5G. Termínala en Clientes → Saldos → Terminar devolución (en efectivo o a la tarjeta).');
    // Telegram lleva el mismo texto.
    expect(incidentMessage('Sala Aurora', i)).toContain('código UYS-J5G. Termínala en Clientes → Saldos');
    expect(walletCloseRequestedIncident({ ...row, shortCode: null }).detail).toBe(
      '29,00 €. Termínala en Clientes → Saldos → Terminar devolución (en efectivo o a la tarjeta).',
    );
  });

  it('pedida antes con parte cargada con bitcoin: se termina el resto; esa parte se queda como saldo para otra noche', () => {
    const mixed = walletCloseRequestedIncident({ ...row, balanceCents: 8_000, bitcoinCents: 3_000 });
    expect(mixed.detail).toBe(
      '80,00 € · código UYS-J5G. Termina la devolución de 50,00 € en Clientes → Saldos → Terminar devolución (en efectivo o a la tarjeta). Los otros 30,00 €: esta parte entró con bitcoin: se queda como saldo para otra noche, no se devuelve.',
    );
    expect(mixed.amountCents).toBe(5_000);
    const allBtc = walletCloseRequestedIncident({ ...row, bitcoinCents: 2_900 });
    expect(allBtc.detail).toBe('29,00 € · código UYS-J5G: todo entró con bitcoin. Esta parte entró con bitcoin: se queda como saldo para otra noche, no se devuelve.');
    expect(allBtc.amountCents).toBe(0);
    expect(walletCloseRequestedIncident({ ...row, bitcoinCents: 0 }).detail).toBe(walletCloseRequestedIncident(row).detail);
  });

  it('el saldo que queda tras cerrar la noche ya no es un aviso: se queda para la próxima visita', () => {
    expect(Object.keys(rules)).not.toContain('walletOpenBalanceIncident');
  });

  it('recarga cobrada que no llegó al saldo: sin «wallet»', () => {
    const i = walletCreditSkippedIncident({ id: 'e-1', paymentId: 'p-1', amountCents: 1_000, occurredAt: row.occurredAt, payload: null });
    expect(i.title).toBe('Recarga cobrada que no llegó al saldo');
    expect(i.detail).toBe('El cliente pagó pero su saldo no estaba activo. Devuélvelo en BBVA o reactiva el saldo.');
    for (const text of [i.title, i.detail, walletCloseRequestedIncident(row).detail]) {
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

describe('avisos de dinero (B11): para cerrarlos hay que escribir qué se hizo', () => {
  it('los de cobros, devoluciones, datáfono, efectivo y banco piden nota', () => {
    for (const kind of [
      'duplicate_charge',
      'amount_mismatch',
      'approval_unbooked',
      'earning_reverse_failed',
      'wallet_credit_skipped',
      'night_closed_pending',
      'pos_charge_mismatch',
      'pos_unmatched_op',
      'pos_voided_paid',
      'pos_unproven_sales',
      'pos_reception_limit',
      'cash_split_suspected',
      'reception_payout_cap',
      'bank_mismatch',
    ] as const) {
      expect(ackNeedsNote({ kind, amountCents: null }), kind).toBe(true);
    }
  });

  it('los que no mueven dinero, no: una ficha bloqueada, las copias o un cambio de ajustes', () => {
    expect(ackNeedsNote({ kind: 'wallet_card_lost', amountCents: 5000 })).toBe(false);
    expect(ackNeedsNote({ kind: 'backup_unmonitored', amountCents: null })).toBe(false);
    expect(ackNeedsNote({ kind: 'sensitive_action', amountCents: null })).toBe(false);
  });

  it('una acción delicada con importe (un cobro sin Face ID, uno dado por pagado a mano) es de dinero', () => {
    expect(ackNeedsNote({ kind: 'sensitive_action', amountCents: 4000 })).toBe(true);
    expect(ackNeedsNote({ kind: 'sensitive_action', amountCents: 0 })).toBe(false);
  });
});

describe('avisos por persona (decisión del dueño, 19-11-2026)', () => {
  const base = { night: '2026-11-18', userId: 'u-ana', name: 'Ana', lastAt: new Date('2026-11-19T02:10:00Z') };

  it('muchas cancelaciones: quién en el panel, no en Telegram; un aviso por persona y noche, que se cierra con nota', () => {
    const i = rules.staffPatternIncident({ ...base, rule: 'cancels', count: 6, amountCents: null });
    expect(i).toMatchObject({
      kind: 'staff_pattern',
      refId: 'cancels:2026-11-18:u-ana',
      title: 'Muchas cancelaciones de una persona',
      occurredAt: '2026-11-19T02:10:00.000Z',
      amountCents: null,
      paymentId: null,
      ackable: true,
    });
    expect(i.detail).toBe('Ana ha cancelado 6 cobros la noche del 2026-11-18. Revisa esos cobros en Hoy → Cobros y habla con esa persona.');
    expect(i.alertDetail).toBe('Alguien del personal ha cancelado 6 cobros la noche del 2026-11-18. Revisa esos cobros en Hoy → Cobros y habla con esa persona.');
    expect(incidentMessage('Sala Aurora', i)).not.toContain('Ana');
    expect(ACKABLE_KINDS as readonly string[]).toContain('staff_pattern');
    expect(SELF_RESOLVING.has('staff_pattern')).toBe(false);
    expect(ackNeedsNote(i)).toBe(true);
  });

  it('mucho «Otro importe», PIN fallado en varios saldos y cobros seguidos al mismo saldo (su código, solo en el panel)', () => {
    const free = rules.staffPatternIncident({ ...base, rule: 'free_amount', count: 4, amountCents: 62_000 });
    expect(free).toMatchObject({ refId: 'free_amount:2026-11-18:u-ana', title: 'Mucho «Otro importe» de una persona', amountCents: 62_000 });
    expect(free.detail).toBe('Ana ha cobrado 620,00 € con «Otro importe» (tecleado, sin la carta) en 4 cobros la noche del 2026-11-18. Comprueba que eran precios del local.');
    const pin = rules.staffPatternIncident({ ...base, rule: 'pin_fails', count: 3, amountCents: null });
    expect(pin).toMatchObject({ refId: 'pin_fails:2026-11-18:u-ana', title: 'PIN fallado en varios saldos' });
    expect(pin.detail).toBe('En el móvil de Ana se ha fallado el PIN de 3 saldos distintos la noche del 2026-11-18. Si no lo tecleaban sus clientes, puede estar probando el PIN de otros: revísalo.');
    expect(pin.alertDetail).toContain('En el móvil de alguien del personal se ha fallado');
    const same = rules.staffPatternIncident({ ...base, rule: 'same_saldo', count: 3, amountCents: 6_000, walletId: 'w-1', shortCode: 'K7Q4M2' });
    expect(same).toMatchObject({ refId: 'same_saldo:2026-11-18:u-ana:w-1', title: 'Cobros seguidos al mismo saldo', amountCents: 6_000 });
    expect(same.detail).toBe('Ana ha cobrado 3 veces al mismo saldo (K7Q-4M2) en 15 minutos (60,00 €) la noche del 2026-11-18. Comprueba con el cliente que lo pidió todo.');
    expect(same.alertDetail).not.toContain('K7Q');
    expect(same.alertDetail).not.toContain('Ana');
  });

  it('sin nombre en el registro: «Alguien del personal» (no se inventa uno)', () => {
    expect(rules.staffPatternIncident({ ...base, name: null, rule: 'cancels', count: 5, amountCents: null }).detail).toMatch(/^Alguien del personal ha cancelado 5 cobros/);
  });
});

describe('API de socios: avisos al dueño (Incidencias y Telegram)', () => {
  const row = (action: string, o: Record<string, unknown> = {}) => ({
    id: 'a9',
    action,
    paymentId: null,
    amountCents: null,
    occurredAt: new Date(),
    payload: { connectionId: 'c1', keyHint: 'oxp_live_…a1b2', name: 'Cajeros Demo', scopes: ['wallet:load'] },
    actorName: 'Marta',
    ...o,
  });

  it.each([
    ['partner.key.created', 'Plataforma conectada', /^Marta ha conectado una plataforma, con su 2FA\. \(Cajeros Demo\)$/],
    ['partner.key.rotated', 'Clave de plataforma cambiada', /^Marta ha cambiado la clave de una plataforma, con su 2FA\./],
    ['partner.key.revoked', 'Clave de plataforma anulada', /^Marta ha anulado la clave de una plataforma\./],
    ['partner.connection.paused', 'Plataforma en pausa', /^Una plataforma está en pausa: mira por qué en su ficha\./],
    ['partner.key.exposed', 'Clave en una dirección web', /^Una plataforma mandó su clave en una dirección web: cámbiala\./],
    ['partner.foreign_ip', 'Clave usada desde otra IP', /^Se rechazó una clave usada desde una IP ajena/],
    ['partner.key.claim_reopened', 'Enlace de clave abierto otra vez', /^Volvieron a abrir el enlace de una clave ya vista/],
    ['partner.key.claim_expired', 'Enlace de clave sin abrir', /^El enlace de una clave caducó sin abrirse: cámbiala\./],
    ['partner.key.expiring', 'Clave a punto de caducar', /^La clave de una plataforma caduca pronto: cámbiala antes\./],
  ])('%s → «%s»', (action, title, detail) => {
    expect(SENSITIVE_AUDIT_ACTIONS).toContain(action);
    const i = sensitiveActionIncident(row(action));
    expect(i).toMatchObject({ kind: 'sensitive_action', title, ackable: true });
    expect(i.detail).toMatch(detail);
    expect(i.alertDetail).not.toMatch(/Marta|Cajeros Demo|oxp_/);
  });

  it('partner.master_link_submitted: el texto nuevo, sin «Alguien del personal»; plataforma y saldo en el panel, no en Telegram', () => {
    expect(SENSITIVE_AUDIT_ACTIONS).toContain('partner.master_link_submitted');
    const i = sensitiveActionIncident(
      row('partner.master_link_submitted', {
        actorName: null,
        payload: { connectionId: 'c1', keyHint: 'oxp_live_…a1b2', name: 'Cajeros Demo', code: 'K7Q-4M2', linkRef: 'a1b2c3d4e5f6' },
      }),
    );
    expect(i).toMatchObject({ kind: 'sensitive_action', title: 'Enlace privado enseñado en otra plataforma', ackable: true });
    expect(i.detail).toBe(
      'Un cliente ha enseñado el enlace privado de su saldo en otra plataforma: quien lo tenga puede ver su saldo. Dale un enlace nuevo. (Cajeros Demo) (saldo K7Q-4M2)',
    );
    expect(i.alertDetail).toBe(
      'Un cliente ha enseñado el enlace privado de su saldo en otra plataforma: quien lo tenga puede ver su saldo. Dale un enlace nuevo.',
    );
    expect(`${i.detail} ${i.alertDetail}`).not.toMatch(/Alguien del personal|a1b2c3d4e5f6|oxp_/);
  });

  it('wallet.card_copy_suspected de una plataforma: «no se ha aceptado», con plataforma y saldo solo en el panel', () => {
    const i = sensitiveActionIncident(
      row('wallet.card_copy_suspected', { actorName: null, payload: { cardId: 'k1', connectionId: 'c1', keyHint: 'oxp_live_…a1b2', name: 'Cajeros Demo', code: 'K7Q-4M2' } }),
    );
    expect(i.detail).toBe(
      'Han acercado una ficha con el código de un saldo y otro número de serie: no se ha aceptado. Si se repite, cambia esa ficha. (Cajeros Demo) (saldo K7Q-4M2)',
    );
    expect(i.alertDetail).toBe('Han acercado una ficha con el código de un saldo y otro número de serie: no se ha aceptado. Si se repite, cambia esa ficha.');
  });

  it('la clave dormida, el enlace abierto y la reanudación no avisan', () => {
    for (const quiet of ['partner.key.suspended', 'partner.key.claim_opened', 'partner.connection.resumed']) {
      expect(SENSITIVE_AUDIT_ACTIONS).not.toContain(quiet);
    }
  });
});
