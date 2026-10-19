import { describe, it, expect } from 'vitest';
import {
  passChargeToken,
  passChargeTokenValid,
  passChargeUrl,
  passChargeWalletId,
} from './pass-charge-token';

/** El QR del pase: solo cobra (con el PIN), atado al saldo y a su enlace actual. */
const SECRET = 'secreto-de-cookies-de-las-pruebas-0123456789';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const LINK = 'cGFzZS1kZWwtc2FsZG8tMDE';

describe('token del QR del pase (solo para cobrar)', () => {
  it('43 caracteres base64url, sin el enlace del saldo dentro; dice de qué saldo es', () => {
    const token = passChargeToken(SECRET, WALLET, LINK);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(LINK);
    expect(passChargeWalletId(token)).toBe(WALLET);
    expect(passChargeTokenValid(SECRET, token, { id: WALLET, qrToken: LINK })).toBe(true);
    expect(passChargeUrl('https://api.paytomaxx.com', SECRET, WALLET, LINK)).toBe(`https://api.paytomaxx.com/c/${token}`);
  });

  it('enlace nuevo (móvil perdido), otra clave, otro saldo o token tocado → no vale', () => {
    const token = passChargeToken(SECRET, WALLET, LINK);
    expect(passChargeTokenValid(SECRET, token, { id: WALLET, qrToken: 'enlace-nuevo-del-saldo-01' })).toBe(false);
    expect(passChargeTokenValid('otra-clave-del-servidor-0123456789', token, { id: WALLET, qrToken: LINK })).toBe(false);
    const other = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f71';
    expect(passChargeTokenValid(SECRET, token, { id: other, qrToken: LINK })).toBe(false);
    const flipped = `${token.slice(0, 30)}${token[30] === 'A' ? 'B' : 'A'}${token.slice(31)}`;
    expect(passChargeTokenValid(SECRET, flipped, { id: WALLET, qrToken: LINK })).toBe(false);
  });

  it('un enlace /w (24 caracteres) o basura no parecen un token de cobro', () => {
    expect(passChargeWalletId(LINK)).toBeNull();
    expect(passChargeWalletId('x'.repeat(42))).toBeNull();
    expect(passChargeWalletId('no/vale/' + 'x'.repeat(35))).toBeNull();
  });

  it('solo para saldos con id UUID', () => {
    expect(() => passChargeToken(SECRET, 'w-1', LINK)).toThrow();
  });
});
