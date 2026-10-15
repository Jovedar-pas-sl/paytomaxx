import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller } from './poller';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sondeo sin solapes', () => {
  it('nunca dos vueltas a la vez aunque la red vaya más lenta que la pausa', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    const poller = createPoller({
      intervalMs: 1000,
      task: async () => {
        runs += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(2500);
        inFlight -= 1;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    poller.stop();
    expect(maxInFlight).toBe(1);
    // Vueltas en 0, 3,5 y 7 s (2,5 s de petición + 1 s de pausa).
    expect(runs).toBe(3);
  });

  it('con la pantalla oculta no pregunta; al volver (poke) pregunta ya', async () => {
    let hidden = false;
    let runs = 0;
    const poller = createPoller({
      intervalMs: 1000,
      isHidden: () => hidden,
      task: async () => {
        runs += 1;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    hidden = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
    hidden = false;
    poller.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(3);
    poller.stop();
  });

  it("la vuelta dice 'stop' (estado final, sesión caducada): no sigue", async () => {
    let runs = 0;
    const poller = createPoller({
      intervalMs: 1000,
      task: async () => {
        runs += 1;
        return runs === 2 ? 'stop' : undefined;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(2);
  });

  it('si falla, espera más antes de volver a preguntar', async () => {
    const at: number[] = [];
    const start = Date.now();
    const poller = createPoller({
      intervalMs: 1000,
      slowIntervalMs: 5000,
      task: async () => {
        at.push(Date.now() - start);
        if (at.length === 1) throw new Error('servidor caído');
        return at.length === 2 ? 'slow' : undefined;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(11_500);
    poller.stop();
    expect(at).toEqual([0, 5000, 10_000, 11_000]);
  });

  it('stop() con una vuelta en marcha: no programa otra', async () => {
    let runs = 0;
    const poller = createPoller({
      intervalMs: 1000,
      task: async () => {
        runs += 1;
        await sleep(500);
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(1);
  });

  it('poke() durante una vuelta: otra justo al acabar, no a la vez', async () => {
    let runs = 0;
    const poller = createPoller({
      intervalMs: 10_000,
      task: async () => {
        runs += 1;
        await sleep(500);
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    poller.poke();
    expect(runs).toBe(1);
    // Acaba a los 500 ms y la siguiente sale ya, sin esperar los 10 s.
    await vi.advanceTimersByTimeAsync(401);
    expect(runs).toBe(2);
    poller.stop();
  });

  it('start(retraso) y una pausa que cambia (más rápido sin tiempo real)', async () => {
    let fast = false;
    const at: number[] = [];
    const start = Date.now();
    const poller = createPoller({
      intervalMs: () => (fast ? 1000 : 4000),
      task: async () => {
        at.push(Date.now() - start);
      },
    });
    poller.start(2000);
    await vi.advanceTimersByTimeAsync(3000);
    fast = true;
    await vi.advanceTimersByTimeAsync(4500);
    poller.stop();
    expect(at).toEqual([2000, 6000, 7000]);
  });
});
