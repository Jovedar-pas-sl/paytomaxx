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
    expect(redactWalletToken('/pay/qr-1')).toBe('/pay/qr-1');
  });
});
