import { describe, expect, it, vi } from 'vitest';
import { createWakeLock, wakeLockFrom, type WakeLockLike, type WakeLockSentinelLike } from '@nightpay/ui';

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
  });
}

function fakeLock(behaviour: 'grant' | 'deny' = 'grant') {
  const sentinels: FakeSentinel[] = [];
  const lock: WakeLockLike = {
    request: vi.fn(async () => {
      if (behaviour === 'deny') throw new DOMException('Battery low', 'NotAllowedError');
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    }),
  };
  return { lock, sentinels };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pantalla encendida mientras hay un cobro abierto', () => {
  it('sin Wake Lock en el navegador: nada (ni falla)', () => {
    expect(wakeLockFrom(undefined)).toBeNull();
    expect(wakeLockFrom(null)).toBeNull();
    expect(wakeLockFrom({})).toBeNull();
    expect(wakeLockFrom({ wakeLock: {} })).toBeNull();
    const ctl = createWakeLock({ wakeLock: null, isVisible: () => true });
    expect(() => {
      ctl.start();
      ctl.onVisibilityChange();
      ctl.stop();
    }).not.toThrow();
  });

  it('lo encuentra en navigator.wakeLock', () => {
    const { lock } = fakeLock();
    expect(wakeLockFrom({ wakeLock: lock })).toBe(lock);
  });

  it('la pide al abrir el cobro y la suelta al terminar', async () => {
    const { lock, sentinels } = fakeLock();
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => true });
    ctl.start();
    await flush();
    expect(lock.request).toHaveBeenCalledWith('screen');
    ctl.stop();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('si la deniegan (batería baja), sigue sin fallar', async () => {
    const { lock } = fakeLock('deny');
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => true });
    ctl.start();
    await flush();
    expect(() => ctl.stop()).not.toThrow();
  });

  it('al volver a la página (el navegador la soltó al ocultarse), la pide otra vez', async () => {
    const { lock, sentinels } = fakeLock();
    let visible = true;
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => visible });
    ctl.start();
    await flush();
    visible = false;
    sentinels[0]!.released = true;
    ctl.onVisibilityChange();
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
    visible = true;
    ctl.onVisibilityChange();
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(2);
  });

  it('con la que tiene aún activa, no pide otra', async () => {
    const { lock } = fakeLock();
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => true });
    ctl.start();
    await flush();
    ctl.onVisibilityChange();
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
  });

  it('con la página oculta no la pide (el navegador la negaría)', async () => {
    const { lock } = fakeLock();
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => false });
    ctl.start();
    await flush();
    expect(lock.request).not.toHaveBeenCalled();
  });

  it('terminado el cobro mientras se pedía: la suelta en cuanto llega', async () => {
    const { lock, sentinels } = fakeLock();
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => true });
    ctl.start();
    ctl.stop();
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('tras terminar, volver a la página no la pide', async () => {
    const { lock } = fakeLock();
    const ctl = createWakeLock({ wakeLock: lock, isVisible: () => true });
    ctl.start();
    await flush();
    ctl.stop();
    ctl.onVisibilityChange();
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
  });
});
