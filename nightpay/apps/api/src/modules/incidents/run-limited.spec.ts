import { describe, it, expect } from 'vitest';
import { runLimited } from './run-limited';

describe('runLimited', () => {
  it('cada resultado en su sitio y nunca más de `limit` a la vez', async () => {
    let inFlight = 0;
    let max = 0;
    const task = (v: number, ms: number) => async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return v;
    };
    const out = await runLimited([task(1, 20), task(2, 1), task(3, 5), task(4, 1), task(5, 1)] as const, 2);
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(max).toBe(2);
  });

  it('empiezan en orden', async () => {
    const started: number[] = [];
    const task = (v: number) => async () => {
      started.push(v);
      return v;
    };
    await runLimited([task(0), task(1), task(2), task(3), task(4)] as const, 3);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('el primer error rechaza (como Promise.all)', async () => {
    await expect(
      runLimited([async () => 1, async () => Promise.reject(new Error('boom')), async () => 3] as const, 2),
    ).rejects.toThrow('boom');
  });

  it('sin tareas: []', async () => {
    await expect(runLimited([] as const, 4)).resolves.toEqual([]);
  });
});
