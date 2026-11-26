import { describe, expect, it } from 'vitest';
import { confirmationCode } from '@nightpay/contracts';
import { cashAmountProblem, needsOwnerApproval, paymentCashProblem, receiptMatches, strayCashMax, withinCashWindow } from './bitcoin-cash-rules';

const NOW = new Date('2026-11-17T01:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const PAY = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const INV = 'Kd8sY5DN6jLHfQfqHkFBnQ';

describe('devolver en efectivo lo pagado con bitcoin: las reglas del dueño', () => {
  const paid = { provider: 'BTCPAY', status: 'AUTHORIZED', walletId: null, authorizedAt: daysAgo(1), availableAmountCents: 5_000 };
  const settled = { status: 'Settled', additionalStatus: null };

  it('un cobro pagado con bitcoin, con la factura pagada en BTCPay y hace menos de 7 días: sí', () => {
    expect(paymentCashProblem(paid, settled, NOW)).toBeNull();
    expect(withinCashWindow(daysAgo(7), NOW)).toBe(true);
    expect(withinCashWindow(daysAgo(7.01), NOW)).toBe(false);
  });

  it('no: tarjeta, recarga del saldo, sin pagar, ya devuelto, pasado el plazo, o sin la factura pagada (marcada o resuelta a mano)', () => {
    expect(paymentCashProblem({ ...paid, provider: 'REDSYS' }, settled, NOW)).toMatch(/bitcoin/);
    // Una carga de saldo con bitcoin: el saldo no se devuelve (nada de «habla con el encargado»).
    expect(paymentCashProblem({ ...paid, walletId: 'w' }, settled, NOW)).toBe('Es una carga de saldo: el saldo no se devuelve, se queda para la próxima visita.');
    expect(paymentCashProblem({ ...paid, status: 'AUTHORIZING' }, settled, NOW)).toMatch(/no está pagado/);
    expect(paymentCashProblem({ ...paid, availableAmountCents: 0 }, settled, NOW)).toMatch(/devuelto del todo/);
    expect(paymentCashProblem({ ...paid, authorizedAt: daysAgo(8) }, settled, NOW)).toMatch(/7 días/);
    expect(paymentCashProblem(paid, { status: 'Settled', additionalStatus: 'Marked' }, NOW)).toMatch(/marcada a mano/);
    expect(paymentCashProblem(paid, null, NOW)).toMatch(/BTCPay no confirma/);
  });

  it('el dueño aprueba cuando PASA de 100 € contando lo ya devuelto; el dueño no pide a nadie', () => {
    expect(needsOwnerApproval({ role: 'MANAGER', alreadyCents: 0, amountCents: 10_000, thresholdCents: 10_000 })).toBe(false);
    expect(needsOwnerApproval({ role: 'MANAGER', alreadyCents: 0, amountCents: 10_001, thresholdCents: 10_000 })).toBe(true);
    expect(needsOwnerApproval({ role: 'MANAGER', alreadyCents: 6_000, amountCents: 5_000, thresholdCents: 10_000 })).toBe(true);
    expect(needsOwnerApproval({ role: 'OWNER', alreadyCents: 6_000, amountCents: 50_000, thresholdCents: 10_000 })).toBe(false);
  });

  it('importe: como mucho lo que queda y por debajo de 1.000 €', () => {
    expect(cashAmountProblem(5_000, 5_000)).toBeNull();
    expect(cashAmountProblem(5_001, 5_000)).toMatch(/Como mucho 50,00\u00a0€/);
    expect(cashAmountProblem(100_000, 200_000)).toMatch(/1.000 €/);
    expect(cashAmountProblem(0, 5_000)).toMatch(/mayor que 0/);
  });

  it('el recibo del cliente: el código de su «Pagado» o el id de su recibo de BTCPay (un trozo de 6)', () => {
    expect(receiptMatches(confirmationCode(PAY).toLowerCase(), { paymentId: PAY, invoiceIds: [INV] })).toBe(true);
    expect(receiptMatches('fqhkfb', { paymentId: PAY, invoiceIds: [INV] })).toBe(true);
    expect(receiptMatches('ZZZ', { paymentId: PAY, invoiceIds: [INV] })).toBe(false);
    expect(receiptMatches('Kd8s', { paymentId: PAY, invoiceIds: [INV] })).toBe(false);
  });

  it('bitcoin sin cobro: lo que llegó (en € de la factura); nunca el que pagó el cobro (ni lo de más), ni marcado, ni sin saber cuánto', () => {
    const stray = { invoiceId: INV, status: 'Expired', additionalStatus: 'PaidPartial', amountCents: 5_000, paidCents: 2_000, closedAt: daysAgo(2), updatedAt: daysAgo(2) };
    expect(strayCashMax(stray, { status: 'AUTHORIZING', providerTxId: INV }, NOW)).toEqual({ ok: true, maxCents: 2_000 });
    expect(strayCashMax({ ...stray, status: 'Settled', additionalStatus: null, paidCents: null }, { status: 'CANCELED', providerTxId: INV }, NOW)).toEqual({ ok: true, maxCents: 5_000 });
    expect(strayCashMax({ ...stray, status: 'Settled', additionalStatus: 'PaidOver', paidCents: 6_000 }, { status: 'AUTHORIZED', providerTxId: INV }, NOW)).toMatchObject({ ok: false });
    expect(strayCashMax({ ...stray, paidCents: null }, { status: 'AUTHORIZING', providerTxId: INV }, NOW)).toMatchObject({ ok: false, problem: expect.stringMatching(/No se sabe/) });
    expect(strayCashMax({ ...stray, additionalStatus: 'Marked' }, { status: 'AUTHORIZING', providerTxId: INV }, NOW)).toMatchObject({ ok: false });
    expect(strayCashMax({ ...stray, closedAt: daysAgo(9) }, { status: 'EXPIRED', providerTxId: INV }, NOW)).toMatchObject({ ok: false, problem: expect.stringMatching(/7 días/) });
    // Pagado con tarjeta y además con bitcoin: el bitcoin sobra y se puede devolver.
    expect(strayCashMax({ ...stray, status: 'Settled', additionalStatus: null, paidCents: 5_000 }, { status: 'AUTHORIZED', providerTxId: '1108A6B2' }, NOW)).toEqual({ ok: true, maxCents: 5_000 });
  });
});
