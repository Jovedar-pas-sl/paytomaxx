import { describe, it, expect } from 'vitest';
import { redactSecretsInUrl, redactSecretsInText, redactWalletToken } from './redact-url';

describe('redactWalletToken', () => {
  it('tapa el token del saldo y deja el resto', () => {
    expect(redactWalletToken('/w/AbC_123-x/state')).toBe('/w/***/state');
    expect(redactWalletToken('/w/AbC_123-x?lang=es')).toBe('/w/***?lang=es');
    expect(redactWalletToken('/w/AbC/requests/9f0c/accept')).toBe('/w/***/requests/9f0c/accept');
  });

  it('no toca otras rutas', () => {
    expect(redactWalletToken('/v1/wallet-charges/lookup/K7Q4M2')).toBe('/v1/wallet-charges/lookup/K7Q4M2');
    expect(redactWalletToken('/v1/payments')).toBe('/v1/payments');
  });
});

describe('otras credenciales en la URL', () => {
  it('QR del cobro, secreto de Paytef, alta de chica y vistas públicas', () => {
    expect(redactSecretsInUrl('/pay/qr-abc?lang=es')).toBe('/pay/***?lang=es');
    expect(redactSecretsInUrl('/pay/qr-abc/receipt')).toBe('/pay/***/receipt');
    expect(redactSecretsInUrl('/v1/webhooks/paytef/sup3rs3cret')).toBe('/v1/webhooks/paytef/***');
    expect(redactSecretsInUrl('/v1/operators/self-onboarding/eyJhbGc.x.y')).toBe('/v1/operators/self-onboarding/***');
    expect(redactSecretsInUrl('/v1/wallets/public/tok')).toBe('/v1/wallets/public/***');
    expect(redactSecretsInUrl('/v1/payments')).toBe('/v1/payments');
  });

  it('QR para pagar con el saldo (/s/<token>) y las mismas rutas con /v1', () => {
    expect(redactSecretsInUrl('/s/QrTok-1/pay')).toBe('/s/***/pay');
    expect(redactSecretsInUrl('/s/QrTok-1')).toBe('/s/***');
    expect(redactSecretsInUrl('/v1/s/QrTok-1/challenge')).toBe('/v1/s/***/challenge');
    expect(redactSecretsInUrl('/v1/w/tok/state')).toBe('/v1/w/***/state');
    expect(redactSecretsInUrl('/v1/pay/tok')).toBe('/v1/pay/***');
  });

  it('el resultado del pago: la ruta queda, el número de operación no', () => {
    expect(redactSecretsInUrl('/pay/result?op=ORD1')).toBe('/pay/result?op=***');
    expect(redactSecretsInUrl('/pay/result')).toBe('/pay/result');
  });

  it('parámetros sensibles en la query (claves de APIs, firmas de Redsys, tokens)', () => {
    expect(redactSecretsInUrl('/api?module=account&apikey=K3Y&page=1')).toBe('/api?module=account&apikey=***&page=1');
    expect(redactSecretsInUrl('/v0/addresses?api-key=abc')).toBe('/v0/addresses?api-key=***');
    expect(redactSecretsInUrl('/ok?Ds_SignatureVersion=HMAC&Ds_MerchantParameters=eyJ&Ds_Signature=s1g')).toBe(
      '/ok?Ds_SignatureVersion=HMAC&Ds_MerchantParameters=***&Ds_Signature=***',
    );
    expect(redactSecretsInUrl('/x?token=t&lang=es')).toBe('/x?token=***&lang=es');
  });

  it('URLs completas (llamadas salientes): token del bot de Telegram en la ruta', () => {
    expect(redactSecretsInUrl('https://api.telegram.org/bot123456:AAH-xyz_9/sendMessage')).toBe(
      'https://api.telegram.org/bot***/sendMessage',
    );
    expect(redactSecretsInUrl('https://api.bscscan.com/api?module=x&apikey=K')).toBe(
      'https://api.bscscan.com/api?module=x&apikey=***',
    );
    expect(redactSecretsInUrl('https://api.example.com/w/tok?x=1')).toBe('https://api.example.com/w/***?x=1');
  });

  it('texto libre con URLs dentro (mensajes, descripciones de trazas)', () => {
    expect(redactSecretsInText('POST https://api.telegram.org/bot1:AbC/sendMessage falló')).toBe(
      'POST https://api.telegram.org/bot***/sendMessage falló',
    );
    expect(redactSecretsInText('GET /w/tok123/state')).toBe('GET /w/***/state');
    expect(redactSecretsInText('sin urls')).toBe('sin urls');
  });
});
