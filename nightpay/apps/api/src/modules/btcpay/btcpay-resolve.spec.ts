import { describe, expect, it } from 'vitest';
import { invoiceRefOf, invoiceRefProblem, matchInvoiceRef } from './btcpay-resolve';

const ID = 'Kd8sY5DN6jLHfQfqHkFBnQ';

describe('«Resolver» un cobro con bitcoin: el id de su factura de BTCPay', () => {
  it('vale el id entero, un trozo de 6 o más (sin mirar mayúsculas) o el enlace de la factura', () => {
    expect(matchInvoiceRef(ID, [ID])).toEqual({ ok: true, invoiceId: ID });
    expect(matchInvoiceRef('fqhkfb', [ID])).toEqual({ ok: true, invoiceId: ID });
    expect(matchInvoiceRef(' Kd8s Y5 ', [ID])).toEqual({ ok: true, invoiceId: ID });
    expect(matchInvoiceRef(`https://btcpay.sala.es/i/${ID}`, [ID])).toEqual({ ok: true, invoiceId: ID });
    expect(invoiceRefOf(`https://btcpay.sala.es/invoices/${ID}?x=1`)).toBe(ID);
  });

  it('corto, de otra factura o que casa con varias del mismo cobro: no vale, y dice por qué', () => {
    expect(matchInvoiceRef('Kd8s', [ID])).toEqual({ ok: false, reason: 'short' });
    expect(matchInvoiceRef('ZZZZZZZ', [ID])).toEqual({ ok: false, reason: 'none' });
    expect(matchInvoiceRef('Kd8sY5', [ID, 'Kd8sY5Xotra000000', null])).toEqual({ ok: false, reason: 'many' });
    // La misma factura repetida (el cobro y su intento) es una sola.
    expect(matchInvoiceRef('Kd8sY5', [ID, ID])).toEqual({ ok: true, invoiceId: ID });
    expect(matchInvoiceRef(ID, [])).toEqual({ ok: false, reason: 'none' });
    expect(invoiceRefProblem('none')).toMatch(/BTCPay/);
    expect(invoiceRefProblem('none')).not.toMatch(/banco|BBVA/);
    expect(invoiceRefProblem('many')).toMatch(/más letras/);
  });
});
