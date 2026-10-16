import { describe, expect, it, vi } from 'vitest';
import { createHealthStore, mergeHealth } from './connection-health';

describe('señales de conexión de las pantallas de cobro', () => {
  it('sin nadie que avise: todo bien', () => {
    expect(mergeHealth([])).toEqual({ serverDown: false, bankWaitingSinceMs: null, orphan: false });
  });

  it('basta una pantalla con el API caído o un cobro sin confirmar', () => {
    expect(mergeHealth([{ serverDown: false }, { serverDown: true }]).serverDown).toBe(true);
    expect(mergeHealth([{}, { orphan: true }]).orphan).toBe(true);
  });

  it('del banco cuenta la espera más larga', () => {
    expect(mergeHealth([{ bankWaitingSinceMs: 500 }, { bankWaitingSinceMs: 200 }, {}]).bankWaitingSinceMs).toBe(200);
  });

  it('avisa a quien escucha solo si cambia algo, y lo quita al irse la pantalla', () => {
    const store = createHealthStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.report('cobro:1', { serverDown: true });
    expect(store.getSnapshot().serverDown).toBe(true);
    store.report('cobro:1', { serverDown: true });
    expect(listener).toHaveBeenCalledTimes(1);
    store.report('cobro:1', null);
    expect(store.getSnapshot().serverDown).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('la foto no cambia de objeto si no cambia nada (useSyncExternalStore no se repinta en bucle)', () => {
    const store = createHealthStore();
    const before = store.getSnapshot();
    store.report('saldo', {});
    expect(store.getSnapshot()).toBe(before);
  });
});
