import { describe, expect, it } from 'vitest';
import { relyingParty } from './passkey-rp';

const prod = { apiUrl: 'https://api.paytomaxx.com', webClientUrl: 'https://pay.paytomaxx.com', production: true };

describe('dominio de la llave del cliente (rpID)', () => {
  it('la misma llave vale en "Pagado" (pay.) y en el QR de la chica (api.)', () => {
    const onPay = relyingParty('pay.paytomaxx.com', prod);
    const onApi = relyingParty('api.paytomaxx.com', prod);
    expect(onPay.rpID).toBe('paytomaxx.com');
    expect(onApi.rpID).toBe('paytomaxx.com');
    expect(onApi.rpIDs).toEqual(['paytomaxx.com']);
    expect(onApi.origins).toEqual(['https://api.paytomaxx.com', 'https://pay.paytomaxx.com']);
  });

  it('solo el API configurado: también el dominio común', () => {
    expect(relyingParty('api.paytomaxx.com', { apiUrl: 'https://api.paytomaxx.com', production: true })).toEqual({
      rpID: 'paytomaxx.com',
      rpIDs: ['paytomaxx.com'],
      origins: ['https://api.paytomaxx.com'],
    });
  });

  it('un Host que no es nuestro no cambia el dominio ni añade orígenes', () => {
    const rp = relyingParty('evil.example', prod);
    expect(rp.rpID).toBe('paytomaxx.com');
    expect(rp.origins).not.toContain('https://evil.example');
  });

  it('PASSKEY_RP_ID manda (dominios .com.es)', () => {
    const rp = relyingParty('api.oxiopay.com.es', {
      apiUrl: 'https://api.oxiopay.com.es',
      rpId: 'oxiopay.com.es',
      production: true,
    });
    expect(rp.rpID).toBe('oxiopay.com.es');
  });

  it('en local: localhost; en producción, sin orígenes de localhost', () => {
    expect(relyingParty('localhost:4100', { apiUrl: 'http://localhost:4100', production: false }).rpID).toBe('localhost');
    expect(relyingParty(undefined, prod).origins.some((o) => o.includes('localhost'))).toBe(false);
  });
});
