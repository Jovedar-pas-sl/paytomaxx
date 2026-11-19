import { describe, expect, it } from 'vitest';
import { alertKindForIncident } from '@nightpay/contracts';
import { ACKABLE_KINDS, ackNeedsNote, paymentAnomalyIncident, type PaymentAnomalyRow } from '../incidents/incident-rules';
import { incidentMessage } from '../incidents/alert-messages';
import { settledPayView, type PayablePayment, type PayResultView } from './pay-redirect';
import { renderClosedPage, renderResultView } from './public-pay.pages';
import { PAID_AFTER_CANCEL_REASON } from './paid-after-cancel';

const plain = (html: string) => html.replace(/\s+/g, ' ');

function lateRow(o: Partial<PaymentAnomalyRow> = {}): PaymentAnomalyRow {
  return {
    id: '901',
    eventType: 'payment.approval_unbooked',
    paymentId: 'p1',
    amountCents: 1_000,
    occurredAt: new Date('2026-11-16T23:40:00Z'),
    payload: { provider: 'REDSYS', providerTxId: '0012ABCD', amountCents: 1_200, fromStatus: 'CANCELED', reason: PAID_AFTER_CANCEL_REASON },
    paymentStatus: 'CANCELED',
    ref: 12,
    ...o,
  };
}

describe('«Pagó después de cancelar»: la incidencia', () => {
  it('título con la referencia y lo que cobró el banco; se cierra con nota; se puede dar por bueno', () => {
    const i = paymentAnomalyIncident(lateRow());
    expect(i).toMatchObject({
      kind: 'approval_unbooked',
      refId: '901',
      title: 'Pagó después de cancelar: C-0012, 12,00 €',
      amountCents: 1_200,
      paymentId: 'p1',
      ackable: true,
      acceptable: true,
    });
    expect(i.detail).toContain('El cobro sigue cancelado: no se ha devuelto ni se ha dado por pagado');
    expect(i.detail).toContain('(pedido 0012ABCD)');
    expect(i.detail).toContain('el portal del banco');
    expect(ackNeedsNote(i)).toBe(true);
    expect(ACKABLE_KINDS as readonly string[]).toContain(i.kind);
  });

  it('ya dado por bueno: sin «Dar por bueno»', () => {
    const i = paymentAnomalyIncident(lateRow({ paymentStatus: 'AUTHORIZED' }));
    expect(i.acceptable).toBeUndefined();
    expect(i.detail).toContain('Ya está dado por bueno');
  });

  it('Telegram: el formato de los avisos de dinero, sin datos del cliente; va con los avisos de cobros', () => {
    const msg = incidentMessage('Sala Aurora', paymentAnomalyIncident(lateRow()));
    expect(msg.split('\n')[0]).toBe('⚠️ Sala Aurora: Pagó después de cancelar: C-0012, 12,00 €');
    expect(msg).not.toMatch(/@|\+34|tarjeta \d|nombre/i);
    expect(alertKindForIncident('approval_unbooked')).toBe('payments');
  });
});

describe('«Pagó después de cancelar»: lo que ve el cliente', () => {
  const TEXT_ES = ['El cobro se canceló, pero tu banco lo ha pagado', 'Habla con el personal: lo devolvemos o lo damos por bueno.'];

  it('vuelta del banco: ni «Pagado» ni «no se te ha cobrado nada»', () => {
    const view = {
      paymentId: 'p1',
      status: 'CANCELED',
      paidAfterCancel: true,
      amountCents: 1_000,
      tipCents: 0,
      currency: 'EUR',
      authorizedAt: null,
      qrToken: 'qr-1',
    } as unknown as PayResultView;
    const html = plain(renderResultView(view, 'es', '/pay/result?op=0012ABCD&lang=es'));
    for (const t of TEXT_ES) expect(html).toContain(t);
    expect(html).not.toContain('No se te ha cobrado nada');
    expect(html).not.toContain('Pagado');
    // Sin el aviso del banco (cancelado de verdad), como siempre.
    const plainCancel = plain(renderResultView({ ...view, paidAfterCancel: undefined }, 'es', '/pay/result?op=X&lang=es'));
    expect(plainCancel).toContain('Este cobro se ha cancelado');
  });

  it('el QR del cobro: la misma página; con el saldo aceptado sigue siendo «pagado con tu saldo»', () => {
    const p = { id: 'p1', status: 'CANCELED', amountCents: 1_000, tipCents: 0, currency: 'EUR', qrExpiresAt: new Date(), authorizedAt: null, allowTip: false, walletToken: null, walletClaimHash: null } as PayablePayment;
    expect(settledPayView({ ...p, paidAfterCancel: true })).toEqual({ kind: 'closed', reason: 'paid-after-cancel' });
    expect(settledPayView(p)).toEqual({ kind: 'closed', reason: 'canceled' });
    expect(settledPayView({ ...p, paidAfterCancel: true, saldo: { payToken: null, status: 'ACCEPTED', expiresAt: new Date(), enabled: true } })).toEqual({
      kind: 'closed',
      reason: 'paid-with-saldo',
    });
  });

  it('en los cuatro idiomas', () => {
    expect(plain(renderClosedPage('paid-after-cancel', 'en'))).toContain('The payment was cancelled, but your bank has paid it');
    expect(plain(renderClosedPage('paid-after-cancel', 'fr'))).toContain('mais votre banque l’a payé');
    expect(plain(renderClosedPage('paid-after-cancel', 'pt'))).toContain('mas o seu banco pagou-o');
  });
});
