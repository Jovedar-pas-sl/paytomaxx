import { describe, it, expect } from 'vitest';
import { redactWalletToken } from './redact-url';

describe('redactWalletToken', () => {
  it('tapa el token del saldo y deja el resto', () => {
    expect(redactWalletToken('/w/AbC_123-x/state')).toBe('/w/***/state');
    expect(redactWalletToken('/w/AbC_123-x?lang=es')).toBe('/w/***?lang=es');
    expect(redactWalletToken('/w/AbC/requests/9f0c/accept')).toBe('/w/***/requests/9f0c/accept');
  });

  it('no toca otras rutas', () => {
    expect(redactWalletToken('/v1/wallet-charges/lookup/K7Q4M2')).toBe('/v1/wallet-charges/lookup/K7Q4M2');
    expect(redactWalletToken('/pay/result?op=1')).toBe('/pay/result?op=1');
  });
});

describe('otras credenciales en la URL', () => {
  it('QR del cobro, secreto de Paytef, alta de chica y vistas públicas', async () => {
    const { redactSecretsInUrl } = await import('./redact-url');
    expect(redactSecretsInUrl('/pay/qr-abc?lang=es')).toBe('/pay/***?lang=es');
    expect(redactSecretsInUrl('/pay/qr-abc/receipt')).toBe('/pay/***/receipt');
    expect(redactSecretsInUrl('/pay/result?op=ORD1')).toBe('/pay/result?op=ORD1');
    expect(redactSecretsInUrl('/v1/webhooks/paytef/sup3rs3cret')).toBe('/v1/webhooks/paytef/***');
    expect(redactSecretsInUrl('/v1/operators/self-onboarding/eyJhbGc.x.y')).toBe('/v1/operators/self-onboarding/***');
    expect(redactSecretsInUrl('/v1/wallets/public/tok')).toBe('/v1/wallets/public/***');
    expect(redactSecretsInUrl('/v1/payments')).toBe('/v1/payments');
  });
});
