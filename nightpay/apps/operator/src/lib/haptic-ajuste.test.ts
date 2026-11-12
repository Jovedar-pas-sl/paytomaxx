import { afterEach, describe, expect, it, vi } from 'vitest';
import { haptic } from '../../../../packages/ui/src/lib/haptic';
import { HAPTIC_KEY } from '../../../../packages/ui/src/lib/device-settings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('haptic respeta el ajuste «Vibrar al tocar»', () => {
  const nav = () => ({ vibrate: vi.fn(() => true) });

  it('vibra por defecto', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const n = nav();
    expect(haptic(12, n)).toBe(true);
    expect(n.vibrate).toHaveBeenCalledWith(12);
  });

  it('con el ajuste apagado, no vibra', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === HAPTIC_KEY ? 'off' : null) });
    const n = nav();
    expect(haptic(12, n)).toBe(false);
    expect(n.vibrate).not.toHaveBeenCalled();
  });

  it('sin vibrate (iPhone, ordenador) no hace nada', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(haptic(12, {} as never)).toBe(false);
  });
});
