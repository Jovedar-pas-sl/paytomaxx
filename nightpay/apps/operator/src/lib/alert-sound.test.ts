import { afterEach, describe, expect, it, vi } from 'vitest';
import { playOutcomeSound, setVenueFeedback } from './alert-sound';

/** Vibración al cobrar según el local (Ajustes → Noche). Sin navegador, el sonido no hace nada. */

afterEach(() => {
  setVenueFeedback({ sound: true, vibration: true });
  vi.unstubAllGlobals();
});

describe('aviso del resultado de un cobro', () => {
  it('de fábrica vibra (dos cortas si se pagó, una larga si no)', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    playOutcomeSound('paid');
    playOutcomeSound('failed');
    expect(vibrate.mock.calls).toEqual([[[60, 50, 120]], [[350]]]);
  });

  it('con la vibración apagada en el local, no vibra', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    setVenueFeedback({ sound: false, vibration: false });
    playOutcomeSound('paid');
    expect(vibrate).not.toHaveBeenCalled();
  });
});
