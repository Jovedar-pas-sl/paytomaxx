import { describe, it, expect } from 'vitest';
import { walletCodeFromQr } from './wallet-qr';

describe('QR del saldo del cliente', () => {
  it('enlace a la app con ?saldo= → el código', () => {
    expect(walletCodeFromQr('https://operator.paytomaxx.com/?saldo=K7Q4M2')).toBe('K7Q4M2');
    expect(walletCodeFromQr(' https://operator.paytomaxx.com/?saldo=k7q-4m2 ')).toBe('K7Q4M2');
  });

  it('el código a secas', () => {
    expect(walletCodeFromQr('K7Q4M2')).toBe('K7Q4M2');
    expect(walletCodeFromQr('k7q-4m2')).toBe('K7Q4M2');
  });

  it('el enlace del saldo del cliente u otros QR no valen', () => {
    expect(walletCodeFromQr('https://api.paytomaxx.com/w/AbCdEf123456789012345678')).toBeNull();
    expect(walletCodeFromQr('https://api.paytomaxx.com/pay/qr-token-1')).toBeNull();
    expect(walletCodeFromQr('https://operator.paytomaxx.com/?saldo=K7Q')).toBeNull();
    expect(walletCodeFromQr('hola')).toBeNull();
    expect(walletCodeFromQr('')).toBeNull();
  });
});
