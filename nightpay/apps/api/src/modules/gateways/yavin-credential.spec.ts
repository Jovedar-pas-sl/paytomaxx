import { describe, it, expect } from 'vitest';
import { openYavinKey, sealYavinKey } from './yavin-credential';

const KEK = 'kek-solo-para-pruebas-0123456789abcdefghij';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';

describe('clave de Yavin cifrada (AES-256-GCM)', () => {
  it('se abre con la misma KEK y el mismo local; el cifrado no lleva la clave en claro', () => {
    const sealed = sealYavinKey(KEK, A, 'clave-inventada');
    expect(sealed.encKey.toString('utf8')).not.toContain('clave-inventada');
    expect(sealed.encNonce).toHaveLength(12);
    expect(sealed.encTag).toHaveLength(16);
    expect(openYavinKey(KEK, A, sealed)).toBe('clave-inventada');
  });

  it('copiada a otro local, o con otra KEK, no se abre', () => {
    const sealed = sealYavinKey(KEK, A, 'clave-inventada');
    expect(() => openYavinKey(KEK, B, sealed)).toThrow();
    expect(() => openYavinKey(`${KEK}-otra`, A, sealed)).toThrow();
  });

  it('sin KEK no se cifra', () => {
    expect(() => sealYavinKey(undefined, A, 'x')).toThrow(/ENCRYPTION_KEK/);
  });
});
