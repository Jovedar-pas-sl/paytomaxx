import { describe, expect, it } from 'vitest';
import { nfcSupported } from './nfc';

describe('fichas NFC', () => {
  it('sin Web NFC (iPhone, ordenador): la app no intenta leer', () => {
    expect(nfcSupported()).toBe(false);
  });
});
