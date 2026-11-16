import { describe, expect, it } from 'vitest';
import { resolveProofFor, resolveProofValue } from './resolve-stuck';

describe('«Resolver» un cobro atascado: con qué se prueba que se cobró', () => {
  it('con el banco: su código de autorización de 6, del portal del banco', () => {
    const bank = resolveProofFor('REDSYS');
    expect(bank.field).toBe('bankAuthCode');
    expect(resolveProofValue(bank, ' 04 7a15 ')).toEqual({ ok: true, value: '047A15' });
    expect(resolveProofValue(bank, 'Kd8sY5DN6')).toMatchObject({ ok: false });
  });

  it('con bitcoin: el id de la factura de BTCPay (o un trozo de 6), y dice dónde verlo', () => {
    const btc = resolveProofFor('BTCPAY');
    expect(btc.field).toBe('btcpayInvoiceRef');
    expect(btc.label).toBe('Id de la factura de BTCPay');
    expect(btc.where).toMatch(/BTCPay.*Facturas/);
    expect(btc.reasonPlaceholder).not.toMatch(/BBVA/);
    expect(resolveProofValue(btc, ' Kd8sY5DN6jLHfQ ')).toEqual({ ok: true, value: 'Kd8sY5DN6jLHfQ' });
    expect(resolveProofValue(btc, 'Kd8s')).toEqual({ ok: false, error: 'Pon el id de la factura de BTCPay: al menos 6 letras o números.' });
  });
});
