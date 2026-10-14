import { describe, expect, it } from 'vitest';
import { isWalletCardToken, normalizeWalletCardUid, walletCardTokenFromUrl, walletCardUrl } from '@nightpay/contracts';

describe('ficha NFC del saldo: el enlace que lleva grabado', () => {
  const token = 'q3VbX9kLmN2pR7sT4wYz1A';

  it('el enlace de la app con su código; y de vuelta', () => {
    const url = walletCardUrl('https://operator.paytomaxx.com/', token);
    expect(url).toBe(`https://operator.paytomaxx.com/?ficha=${token}`);
    expect(walletCardTokenFromUrl(url)).toBe(token);
    // Cabe de sobra en una NTAG213 (144 bytes).
    expect(new TextEncoder().encode(url).length).toBeLessThan(100);
  });

  it('una ficha de otra cosa (u otro enlace) no es nuestra', () => {
    expect(walletCardTokenFromUrl('https://ejemplo.com/')).toBeNull();
    expect(walletCardTokenFromUrl('https://operator.paytomaxx.com/?ficha=corto')).toBeNull();
    expect(walletCardTokenFromUrl('https://operator.paytomaxx.com/?ficha=<script>alert(1)</script>xxxxx')).toBeNull();
    expect(walletCardTokenFromUrl('no es un enlace')).toBeNull();
    expect(isWalletCardToken(token)).toBe(true);
    expect(isWalletCardToken('a/b')).toBe(false);
  });

  it('número de serie: mayúsculas sin separadores', () => {
    expect(normalizeWalletCardUid('04:a2:3b:5c:1d:80:00')).toBe('04A23B5C1D8000');
    expect(normalizeWalletCardUid('04:a2')).toBeNull();
  });
});
