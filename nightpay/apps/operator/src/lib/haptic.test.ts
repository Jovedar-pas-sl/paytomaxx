import { describe, expect, it, vi } from 'vitest';
import { HAPTIC_BAD, HAPTIC_TAP_MS, haptic } from '../../../../packages/ui/src/lib/haptic';

describe('haptic', () => {
  it('el toque normal es corto (10-15 ms)', () => {
    expect(HAPTIC_TAP_MS).toBeGreaterThanOrEqual(10);
    expect(HAPTIC_TAP_MS).toBeLessThanOrEqual(15);
  });

  it('vibra con el patrón pedido', () => {
    const vibrate = vi.fn(() => true);
    expect(haptic(HAPTIC_TAP_MS, { vibrate })).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_TAP_MS);
    haptic(HAPTIC_BAD, { vibrate });
    expect(vibrate).toHaveBeenLastCalledWith([30, 60, 30]);
  });

  it('sin navigator.vibrate (iOS, ordenador) no hace nada ni falla', () => {
    expect(haptic(12, {} as Pick<Navigator, 'vibrate'>)).toBe(false);
  });

  it('si vibrate lanza, no rompe el toque', () => {
    const vibrate = vi.fn(() => {
      throw new Error('bloqueado');
    });
    expect(haptic(12, { vibrate })).toBe(false);
  });
});
