import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, createLongPress } from './long-press';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('mantener pulsada una loseta', () => {
  it('pasado el tiempo dispara, y el click que sigue ya no es un toque', () => {
    const onLong = vi.fn();
    const lp = createLongPress(onLong);
    lp.down(10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLong).toHaveBeenCalledTimes(1);
    expect(lp.click()).toBe(false);
    expect(lp.click()).toBe(true);
  });
  it('un toque corto no dispara y sí es un toque', () => {
    const onLong = vi.fn();
    const lp = createLongPress(onLong);
    lp.down(10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    lp.cancel();
    vi.advanceTimersByTime(1000);
    expect(onLong).not.toHaveBeenCalled();
    expect(lp.click()).toBe(true);
  });
  it('mover el dedo (scroll) lo cancela; un temblor pequeño no', () => {
    const onLong = vi.fn();
    const lp = createLongPress(onLong);
    lp.down(0, 0);
    lp.move(3, 3);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLong).toHaveBeenCalledTimes(1);
    lp.down(0, 0);
    lp.move(0, 40);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLong).toHaveBeenCalledTimes(1);
  });
});
