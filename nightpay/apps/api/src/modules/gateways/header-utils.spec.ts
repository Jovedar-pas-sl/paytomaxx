import { describe, it, expect } from 'vitest';
import { parseWebhookBody } from './header-utils';

describe('parseWebhookBody — body persistido en webhook_deliveries', () => {
  it('parsea JSON (Paytef, Peanpe sintético)', () => {
    const raw = Buffer.from(JSON.stringify({ a: '1', _paymentId: 'p-1' }), 'utf8');
    expect(parseWebhookBody(raw)).toEqual({ a: '1', _paymentId: 'p-1' });
  });

  it('parsea form-urlencoded (Redsys, Wipay)', () => {
    const raw = Buffer.from('Ds_SignatureVersion=HMAC_SHA256_V1&Ds_Signature=ab%2Bc%3D', 'utf8');
    expect(parseWebhookBody(raw)).toEqual({
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_Signature: 'ab+c=',
    });
  });

  it('body vacío → objeto vacío', () => {
    expect(parseWebhookBody(Buffer.alloc(0))).toEqual({});
  });
});
