import { describe, it, expect } from 'vitest';
import { LEGACY_SUBSCRIBE_DEFAULT_UNTIL, legacySubscribeUntil } from './realtime-legacy';

describe('legacySubscribeUntil (REALTIME_LEGACY_SUBSCRIBE_UNTIL)', () => {
  it('sin definir o vacía → 2026-11-15 00:00 de Madrid', () => {
    expect(LEGACY_SUBSCRIBE_DEFAULT_UNTIL).toBe('2026-11-15T00:00:00+01:00');
    expect(legacySubscribeUntil(undefined)?.toISOString()).toBe('2026-11-14T23:00:00.000Z');
    expect(legacySubscribeUntil('  ')?.toISOString()).toBe('2026-11-14T23:00:00.000Z');
  });

  it('"off" (como sea escrito) → apagada ya', () => {
    expect(legacySubscribeUntil('off')).toBeNull();
    expect(legacySubscribeUntil(' Off ')).toBeNull();
  });

  it('otra fecha con zona → esa', () => {
    expect(legacySubscribeUntil('2026-12-01T00:00:00+01:00')?.toISOString()).toBe('2026-11-30T23:00:00.000Z');
  });

  it('valor que no vale → error que nombra la variable', () => {
    expect(() => legacySubscribeUntil('2026-11-15')).toThrow(/REALTIME_LEGACY_SUBSCRIBE_UNTIL/);
  });
});
