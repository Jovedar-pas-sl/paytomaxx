import { describe, it, expect } from 'vitest';
import { openBtcpaySecret, sealBtcpaySecret } from './btcpay-secrets';

const KEK = 'clave-del-servidor-para-las-pruebas-0123456789';
const T1 = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const T2 = 'b7e1d2c3-0000-4000-8000-00000000beef';

describe('btcpay-secrets: la clave de API y el secreto del aviso, cifrados', () => {
  it('se guarda cifrada y vuelve igual', () => {
    const sealed = sealBtcpaySecret(KEK, T1, 'apikey', 'CLAVE-SECRETA-123');
    expect(sealed).not.toContain('CLAVE-SECRETA-123');
    expect(openBtcpaySecret(KEK, T1, 'apikey', sealed)).toBe('CLAVE-SECRETA-123');
  });
  it('cada vez sale distinto (nonce al azar)', () => {
    expect(sealBtcpaySecret(KEK, T1, 'apikey', 'x')).not.toBe(sealBtcpaySecret(KEK, T1, 'apikey', 'x'));
  });
  it('copiada a otro local no se abre (el local va en los datos autenticados)', () => {
    const sealed = sealBtcpaySecret(KEK, T1, 'apikey', 'CLAVE');
    expect(() => openBtcpaySecret(KEK, T2, 'apikey', sealed)).toThrow();
  });
  it('la clave no se confunde con el secreto del aviso', () => {
    const sealed = sealBtcpaySecret(KEK, T1, 'apikey', 'CLAVE');
    expect(() => openBtcpaySecret(KEK, T1, 'webhook', sealed)).toThrow();
  });
  it('con otra ENCRYPTION_KEK no se abre', () => {
    const sealed = sealBtcpaySecret(KEK, T1, 'apikey', 'CLAVE');
    expect(() => openBtcpaySecret(`${KEK}-otra`, T1, 'apikey', sealed)).toThrow();
  });
  it('sin ENCRYPTION_KEK no cifra ni abre', () => {
    expect(() => sealBtcpaySecret(undefined, T1, 'apikey', 'x')).toThrow(/ENCRYPTION_KEK/);
    expect(() => sealBtcpaySecret('corta', T1, 'apikey', 'x')).toThrow(/ENCRYPTION_KEK/);
  });
  it('un texto tocado no se abre', () => {
    const sealed = sealBtcpaySecret(KEK, T1, 'apikey', 'CLAVE');
    // Se cambia un bit del cifrado de verdad. Cambiar los dos últimos caracteres
    // por «AA» a veces no cambiaba ningún byte (los bits sobrantes del base64, o
    // ya acababa en «AA»): 1 de cada 200 veces la prueba fallaba sola.
    const [nonce = '', enc = '', tag = ''] = sealed.split(':');
    const bytes = Buffer.from(enc, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = [nonce, bytes.toString('base64url'), tag].join(':');
    expect(tampered).not.toBe(sealed);
    expect(() => openBtcpaySecret(KEK, T1, 'apikey', tampered)).toThrow();
  });
});
