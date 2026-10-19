import { describe, it, expect } from 'vitest';
import { LEGACY_SUBSCRIBE_DEFAULT_UNTIL, legacySubscribeUntil } from './realtime-legacy';

describe('legacySubscribeUntil (REALTIME_LEGACY_SUBSCRIBE_UNTIL)', () => {
  it('sin definir o vacía → martes 2026-11-17 12:00 de Madrid (fuera de la noche y del fin de semana)', () => {
    expect(LEGACY_SUBSCRIBE_DEFAULT_UNTIL).toBe('2026-11-17T12:00:00+01:00');
    expect(legacySubscribeUntil(undefined)?.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    expect(legacySubscribeUntil('  ')?.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    expect(new Date(LEGACY_SUBSCRIBE_DEFAULT_UNTIL).getUTCDay()).toBe(2);
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
