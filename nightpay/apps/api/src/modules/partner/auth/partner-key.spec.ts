import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PARTNER_KEY_RE } from '@nightpay/contracts';
import { generatePartnerKey, hashPartnerKey, partnerKeyHint, partnerKeyModeOf } from './partner-key';

describe('claves de socio', () => {
  it('oxp_<modo>_ + 48 hex (192 bits al azar), su sha256 y su pista', () => {
    const live = generatePartnerKey('live');
    expect(live.key).toMatch(PARTNER_KEY_RE);
    expect(live.key.startsWith('oxp_live_')).toBe(true);
    expect(live.hash).toBe(createHash('sha256').update(live.key).digest('hex'));
    expect(live.hint).toBe(`oxp_live_…${live.key.slice(-4)}`);
    expect(live.mode).toBe('live');
    expect(generatePartnerKey('test').key.startsWith('oxp_test_')).toBe(true);
    expect(generatePartnerKey('live').key).not.toBe(live.key);
  });

  it('el modo sale del prefijo; lo que no es una clave, ninguno', () => {
    const key = `oxp_test_${'a'.repeat(48)}`;
    expect(partnerKeyModeOf(key)).toBe('test');
    expect(partnerKeyModeOf(`oxp_live_${'0'.repeat(48)}`)).toBe('live');
    expect(partnerKeyModeOf(`oxp_live_${'A'.repeat(48)}`)).toBeNull();
    expect(partnerKeyModeOf('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeNull();
    expect(partnerKeyHint(key)).toBe('oxp_test_…aaaa');
    expect(hashPartnerKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });
});
