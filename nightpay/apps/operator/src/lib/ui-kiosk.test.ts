import { describe, expect, it, vi } from 'vitest';
import { createKiosk, type KioskEnv } from '@nightpay/ui';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeEnv(over: Partial<KioskEnv> = {}) {
  let full = false;
  const keyboard = { lock: vi.fn(async () => undefined), unlock: vi.fn() };
  const native = { lockApp: vi.fn(), unlockApp: vi.fn() };
  const env = {
    isFullscreen: () => full,
    requestFullscreen: vi.fn(async () => {
      full = true;
    }),
    exitFullscreen: vi.fn(async () => {
      full = false;
    }),
    keyboard,
    native,
    ...over,
  } satisfies KioskEnv;
  return { env, keyboard, native, dropFullscreen: () => { full = false; } };
}

describe('pantalla completa con la salida bloqueada mientras hay sesión', () => {
  it('al entrar: pantalla completa, Esc bloqueado y la app del aparato fijada', async () => {
    const { env, keyboard, native } = fakeEnv();
    createKiosk(env).enter();
    await flush();
    expect(env.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(keyboard.lock).toHaveBeenCalledWith(['Escape']);
    expect(native.lockApp).toHaveBeenCalledTimes(1);
  });

  it('ya en pantalla completa: otro toque no la vuelve a pedir', async () => {
    const { env } = fakeEnv();
    const kiosk = createKiosk(env);
    kiosk.enter();
    await flush();
    kiosk.enter();
    expect(env.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('si se salen (gesto, Esc largo), el siguiente toque la recupera', async () => {
    const { env, dropFullscreen } = fakeEnv();
    const kiosk = createKiosk(env);
    kiosk.enter();
    await flush();
    dropFullscreen();
    kiosk.enter();
    expect(env.requestFullscreen).toHaveBeenCalledTimes(2);
  });

  it('al salir de la sesión: se quita la pantalla completa y el bloqueo', async () => {
    const { env, keyboard, native } = fakeEnv();
    const kiosk = createKiosk(env);
    kiosk.enter();
    await flush();
    kiosk.leave();
    expect(env.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
    expect(native.unlockApp).toHaveBeenCalledTimes(1);
  });

  it('si la app del aparato falla, ni rompe ni deja la pantalla completa puesta al salir', async () => {
    const boom = () => {
      throw new Error('puente cerrado');
    };
    const { env } = fakeEnv({ native: { lockApp: boom, unlockApp: boom } });
    const kiosk = createKiosk(env);
    expect(() => kiosk.enter()).not.toThrow();
    await flush();
    expect(env.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(() => kiosk.leave()).not.toThrow();
    expect(env.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('donde no hay pantalla completa (iPhone) o la deniegan: nada, ni falla', async () => {
    const bare = createKiosk({ isFullscreen: () => false, requestFullscreen: null, exitFullscreen: null, keyboard: null, native: null });
    expect(() => {
      bare.enter();
      bare.leave();
    }).not.toThrow();
    const { env, keyboard } = fakeEnv({
      requestFullscreen: vi.fn(async () => {
        throw new TypeError('sin gesto del usuario');
      }),
    });
    createKiosk(env).enter();
    await flush();
    expect(keyboard.lock).not.toHaveBeenCalled();
  });
});
