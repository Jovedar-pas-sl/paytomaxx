import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  REQUIRED_PERMISSIONS,
  centsToDecimal,
  checkKeyPermissions,
  decimalToCents,
  describeBtcpayFailure,
  judgeInvoice,
  purposeAllows,
  unifiedPaymentLink,
  verifyBtcpaySignature,
  type InvoiceData,
} from './btcpay-logic';

describe('centsToDecimal / decimalToCents', () => {
  it.each([
    [1, '0.01'],
    [5, '0.05'],
    [99, '0.99'],
    [100, '1.00'],
    [1250, '12.50'],
    [123456, '1234.56'],
    [10_000_00, '10000.00'],
  ])('%i céntimos = %s', (cents, text) => {
    expect(centsToDecimal(cents)).toBe(text);
    expect(decimalToCents(text)).toBe(cents);
  });

  it('no admite importes que no sean enteros positivos', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => centsToDecimal(bad)).toThrow();
  });

  it('lee lo que devuelve BTCPay: «12.5», «12.500», «12» y se niega a redondear', () => {
    expect(decimalToCents('12.5')).toBe(1250);
    expect(decimalToCents('12.500')).toBe(1250);
    expect(decimalToCents('12')).toBe(1200);
    expect(decimalToCents('0.015')).toBeNull();
    expect(decimalToCents('12.504')).toBeNull();
    for (const bad of ['', '-1', '1,5', 'abc', '1e3', ' 1', '1.', '.5', '0x10']) expect(decimalToCents(bad), bad).toBeNull();
    expect(decimalToCents(undefined)).toBeNull();
    expect(decimalToCents(12.5)).toBeNull();
  });
});

describe('verifyBtcpaySignature', () => {
  const secret = 'secreto-de-prueba-0123456789';
  const body = Buffer.from('{"type":"InvoiceSettled","invoiceId":"A1","metadata":{"orderId":"x"}}', 'utf8');
  const sign = (b: Buffer, s = secret) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  it('firma buena', () => {
    expect(verifyBtcpaySignature(secret, body, sign(body))).toBe(true);
  });
  it('firma mala o de otro secreto', () => {
    expect(verifyBtcpaySignature(secret, body, sign(body, 'otro'))).toBe(false);
    expect(verifyBtcpaySignature(secret, body, 'sha256=' + '0'.repeat(64))).toBe(false);
  });
  it('cuerpo alterado, aunque sea un espacio', () => {
    const tampered = Buffer.from(body.toString('utf8').replace('"A1"', '"A2"'), 'utf8');
    expect(verifyBtcpaySignature(secret, tampered, sign(body))).toBe(false);
    expect(verifyBtcpaySignature(secret, Buffer.concat([body, Buffer.from(' ')]), sign(body))).toBe(false);
  });
  it('el JSON vuelto a escribir no vale: la firma es sobre los bytes recibidos', () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8')), null, 2), 'utf8');
    expect(verifyBtcpaySignature(secret, pretty, sign(body))).toBe(false);
  });
  it.each([undefined, '', 'sha256=', 'sha256=zz', 'md5=abc', sign(body).replace('sha256=', ''), `${sign(body)}00`, 'SHA256=' + 'a'.repeat(64)])(
    'cabecera rara %s',
    (header) => {
      expect(verifyBtcpaySignature(secret, body, header as string | undefined)).toBe(false);
    },
  );
  it('sin secreto o sin cuerpo no hay firma que valga', () => {
    expect(verifyBtcpaySignature('', body, sign(body, ''))).toBe(false);
    expect(verifyBtcpaySignature(secret, null, sign(body))).toBe(false);
  });
  it('acepta la firma en hexadecimal con mayúsculas', () => {
    expect(verifyBtcpaySignature(secret, body, sign(body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });
});

function invoice(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    id: 'INV1',
    storeId: 'STORE1',
    amount: '12.50',
    currency: 'EUR',
    status: 'Settled',
    additionalStatus: 'None',
    metadata: { orderId: 'pay-1' },
    expirationTime: 1_800_000_900,
    checkoutLink: 'https://pay.sala-bambu.es/i/INV1',
    ...over,
  };
}
const expected = { storeId: 'STORE1', orderId: 'pay-1', amountCents: 1250 };

describe('judgeInvoice: lo que se comprueba de la factura que vuelve a pedirse', () => {
  it('Settled con todo cuadrado = pagada', () => {
    expect(judgeInvoice(invoice(), expected)).toEqual({ kind: 'PAID' });
  });
  it('Settled pagada de más sigue siendo pagada (el importe facturado es el que cuenta)', () => {
    expect(judgeInvoice(invoice({ additionalStatus: 'PaidOver' }), expected)).toEqual({ kind: 'PAID' });
  });
  it.each(['New', 'Processing'] as const)('%s = abierta', (status) => {
    expect(judgeInvoice(invoice({ status }), expected)).toEqual({ kind: 'OPEN' });
  });
  it.each(['Expired', 'Invalid'] as const)('%s sin pago = cerrada', (status) => {
    expect(judgeInvoice(invoice({ status }), expected)).toEqual({ kind: 'CLOSED', status });
  });
  it('caducada con pago a medias o tardío = incidencia, nunca pagada', () => {
    expect(judgeInvoice(invoice({ status: 'Expired', additionalStatus: 'PaidPartial' }), expected)).toMatchObject({ kind: 'INCIDENT', reason: 'PAID_PARTIAL' });
    expect(judgeInvoice(invoice({ status: 'Expired', additionalStatus: 'PaidLate' }), expected)).toMatchObject({ kind: 'INCIDENT', reason: 'PAID_LATE' });
    expect(judgeInvoice(invoice({ status: 'Invalid', additionalStatus: 'PaidLate' }), expected)).toMatchObject({ kind: 'INCIDENT', reason: 'PAID_LATE' });
  });
  it('Settled con pago tardío también es incidencia: llegó después de caducar', () => {
    expect(judgeInvoice(invoice({ additionalStatus: 'PaidLate' }), expected)).toMatchObject({ kind: 'INCIDENT', reason: 'PAID_LATE' });
  });
  it('Settled pero a medias no puede darse por pagada', () => {
    expect(judgeInvoice(invoice({ additionalStatus: 'PaidPartial' }), expected)).toMatchObject({ kind: 'INCIDENT', reason: 'PAID_PARTIAL' });
  });
  it.each([
    ['tienda distinta', { storeId: 'OTRA' }, 'STORE_MISMATCH'],
    ['otro cobro', { metadata: { orderId: 'pay-2' } }, 'ORDER_MISMATCH'],
    ['sin orderId', { metadata: {} }, 'ORDER_MISMATCH'],
    ['otra moneda', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['menos importe', { amount: '12.49' }, 'AMOUNT_MISMATCH'],
    ['más importe', { amount: '12.51' }, 'AMOUNT_MISMATCH'],
    ['importe raro', { amount: '12.505' }, 'AMOUNT_MISMATCH'],
  ])('rechaza (%s) aunque diga Settled', (_n, over, reason) => {
    expect(judgeInvoice(invoice(over as Partial<InvoiceData>), expected)).toEqual({ kind: 'REJECTED', reason });
  });
  it('rechaza también una factura abierta o cerrada que no es de ese cobro', () => {
    expect(judgeInvoice(invoice({ status: 'New', metadata: { orderId: 'otro' } }), expected)).toMatchObject({ kind: 'REJECTED' });
    expect(judgeInvoice(invoice({ status: 'Expired', storeId: 'X' }), expected)).toMatchObject({ kind: 'REJECTED' });
  });
});

describe('unifiedPaymentLink: el QR con bitcoin normal y Lightning', () => {
  const chain = { paymentMethodId: 'BTC-CHAIN', destination: 'bc1qxyz', paymentLink: 'bitcoin:bc1qxyz?amount=0.00031', amount: '0.00031', rate: '64000', activated: true };
  const ln = { paymentMethodId: 'BTC-LN', destination: 'lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123', paymentLink: 'lightning:lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123', amount: '0.00031', rate: '64000', activated: true };

  it('une los dos: bitcoin:...&lightning=BOLT11', () => {
    expect(unifiedPaymentLink([chain, ln])).toEqual({
      link: 'bitcoin:bc1qxyz?amount=0.00031&lightning=lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123',
      chainAddress: 'bc1qxyz',
      amountBtc: '0.00031',
      rate: '64000',
    });
  });
  it('solo bitcoin normal: el enlace tal cual', () => {
    expect(unifiedPaymentLink([chain])?.link).toBe('bitcoin:bc1qxyz?amount=0.00031');
  });
  it('solo Lightning: el enlace lightning:', () => {
    expect(unifiedPaymentLink([ln])).toMatchObject({ link: 'lightning:lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123', chainAddress: null });
  });
  it('un método sin activar no cuenta', () => {
    expect(unifiedPaymentLink([chain, { ...ln, activated: false, paymentLink: '', destination: '' }])?.link).toBe('bitcoin:bc1qxyz?amount=0.00031');
  });
  it('si el enlace de bitcoin ya trae otros parámetros, añade con «&»', () => {
    const withPj = { ...chain, paymentLink: 'bitcoin:bc1qxyz?amount=0.00031&pj=https://x/pj' };
    expect(unifiedPaymentLink([withPj, ln])?.link).toBe('bitcoin:bc1qxyz?amount=0.00031&pj=https://x/pj&lightning=lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123');
  });
  it('una factura Lightning con prefijo no se duplica', () => {
    expect(unifiedPaymentLink([chain, { ...ln, destination: 'lightning:lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123' }])?.link).toContain('&lightning=lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123');
    expect(unifiedPaymentLink([chain, { ...ln, destination: 'lightning:lnbc310n1p3xyzabcdefghijklmnopqrstuvwxyz0123' }])?.link).not.toContain('lightning=lightning');
  });
  it('sin ningún método con enlace no hay QR', () => {
    expect(unifiedPaymentLink([])).toBeNull();
    expect(unifiedPaymentLink([{ ...chain, paymentLink: '' }])).toBeNull();
  });
  it('rechaza enlaces que no sean bitcoin:/lightning: (nada de javascript: ni http:)', () => {
    expect(unifiedPaymentLink([{ ...chain, paymentLink: 'javascript:alert(1)' }])).toBeNull();
    expect(unifiedPaymentLink([{ ...chain, paymentLink: 'https://evil.example/pay' }])).toBeNull();
    expect(unifiedPaymentLink([chain, { ...ln, destination: 'lnbc1&evil=1' }])?.link).toBe('bitcoin:bc1qxyz?amount=0.00031');
  });
});

describe('checkKeyPermissions: permisos de la clave de API', () => {
  const store = 'STORE1';
  it('con los tres, sin sufijo o con el id de la tienda, está bien y no sobra nada', () => {
    const r = checkKeyPermissions(REQUIRED_PERMISSIONS.map((p) => `${p}:${store}`), store);
    expect(r).toEqual({ ok: true, missing: [], extra: [] });
    expect(checkKeyPermissions([...REQUIRED_PERMISSIONS], store).ok).toBe(true);
  });
  it('avisa de los que faltan', () => {
    const r = checkKeyPermissions(['btcpay.store.cancreateinvoice:STORE1'], store);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['btcpay.store.canviewinvoices', 'btcpay.store.webhooks.canmodifywebhooks']);
  });
  it('avisa de los que sobran (cualquiera fuera de los tres)', () => {
    const r = checkKeyPermissions([...REQUIRED_PERMISSIONS, 'btcpay.store.canmodifystoresettings:STORE1', 'btcpay.server.canmanageusers'], store);
    expect(r.ok).toBe(true);
    expect(r.extra).toEqual(['btcpay.store.canmodifystoresettings:STORE1', 'btcpay.server.canmanageusers']);
  });
  it('un permiso de OTRA tienda no cuenta', () => {
    const r = checkKeyPermissions(REQUIRED_PERMISSIONS.map((p) => `${p}:OTRA`), store);
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(3);
    expect(r.extra).toHaveLength(3);
  });
  it('un permiso general que lo incluye (canmodifystoresettings no es canviewinvoices) no vale por otro', () => {
    expect(checkKeyPermissions(['btcpay.store.canmodifystoresettings'], store).missing).toHaveLength(3);
  });
  it('sin permisos o con basura', () => {
    expect(checkKeyPermissions([], store).missing).toHaveLength(3);
    expect(checkKeyPermissions(undefined as never, store).missing).toHaveLength(3);
  });
});

describe('describeBtcpayFailure: mensajes para el dueño', () => {
  it('clave mala', () => {
    expect(describeBtcpayFailure(401, { code: 'unauthenticated', message: 'ApiKey authentication failed' })).toMatchObject({ code: 'BAD_KEY' });
  });
  it('faltan permisos y dice cuál', () => {
    const f = describeBtcpayFailure(403, { code: 'missing-permission', missingPermission: 'btcpay.store.cancreateinvoice', message: 'x' });
    expect(f.code).toBe('MISSING_PERMISSION');
    expect(f.message).toContain('btcpay.store.cancreateinvoice');
  });
  it('tienda que no existe', () => {
    expect(describeBtcpayFailure(404, { code: 'store-not-found', message: 'x' })).toMatchObject({ code: 'STORE_NOT_FOUND' });
    expect(describeBtcpayFailure(404, null)).toMatchObject({ code: 'STORE_NOT_FOUND' });
  });
  it('sin cartera vinculada', () => {
    const f = describeBtcpayFailure(400, { code: 'generic-error', message: 'No wallet has been linked to your BTCPay Store. See the following link...' });
    expect(f.code).toBe('NO_WALLET');
    expect(f.message).toMatch(/cartera/i);
  });
  it('validación 422 con la lista de campos', () => {
    expect(describeBtcpayFailure(422, [{ path: 'Url', message: 'Invalid Url' }])).toMatchObject({ code: 'REJECTED' });
  });
  it('5xx y 429 son pasajeros; el resto no', () => {
    expect(describeBtcpayFailure(503, null).transient).toBe(true);
    expect(describeBtcpayFailure(429, null).transient).toBe(true);
    expect(describeBtcpayFailure(401, null).transient).toBe(false);
  });
  it('el mensaje al dueño nunca lleva el texto crudo de BTCPay con la clave', () => {
    const f = describeBtcpayFailure(401, { message: 'token SECRETO-123 no vale' });
    expect(JSON.stringify(f)).not.toContain('SECRETO-123');
  });
});

describe('purposeAllows: cobros, recargas o los dos', () => {
  it.each([
    ['PAYMENTS', false, true],
    ['PAYMENTS', true, false],
    ['TOPUPS', true, true],
    ['TOPUPS', false, false],
    ['BOTH', true, true],
    ['BOTH', false, true],
    ['RARO', true, false],
    [undefined, false, false],
    [null, true, false],
  ])('%s con recarga=%s → %s', (purpose, topUp, expected) => {
    expect(purposeAllows(purpose, topUp)).toBe(expected);
  });
});
