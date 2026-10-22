import { beforeEach, describe, expect, it } from 'vitest';
import { captureInviteFromUrl, INVITE_FRESH_MS, takePendingInvite } from './invite-link';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
});

function fakeWindow(href: string) {
  const replaced: string[] = [];
  return {
    win: {
      location: { href } as Location,
      history: { replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) } as History,
    },
    replaced,
  };
}

describe('«Copa con invitación»: el QR de la chica leído con la cámara del móvil', () => {
  it('se apunta, se quita de la URL y lo recoge el cobro una sola vez', () => {
    const { win, replaced } = fakeWindow('https://op.example/?invita=abcdefghij.KLMNOPQRST-uv&tab=inicio');
    expect(captureInviteFromUrl(win, 1000)).toBe(true);
    expect(replaced).toEqual(['https://op.example/?tab=inicio']);
    expect(takePendingInvite(1000 + 5_000)).toBe('abcdefghij.KLMNOPQRST-uv');
    // Vale una vez.
    expect(takePendingInvite(1000 + 6_000)).toBeNull();
  });

  it('pasado el rato ya no vale (era para el cobro de entonces)', () => {
    const { win } = fakeWindow('https://op.example/?invita=abcdefghij.KLMNOPQRST-uv');
    captureInviteFromUrl(win, 0);
    expect(takePendingInvite(INVITE_FRESH_MS + 1)).toBeNull();
  });

  it('sin ?invita= no toca nada; vacío se quita de la URL pero no se apunta', () => {
    const plain = fakeWindow('https://op.example/?tab=saldo');
    expect(captureInviteFromUrl(plain.win)).toBe(false);
    expect(plain.replaced).toEqual([]);
    const empty = fakeWindow('https://op.example/?invita=');
    expect(captureInviteFromUrl(empty.win)).toBe(false);
    expect(empty.replaced).toEqual(['https://op.example/']);
    expect(takePendingInvite()).toBeNull();
  });

  it('lo apuntado roto no rompe nada', () => {
    store.set('np_invita', '{no es json');
    expect(takePendingInvite()).toBeNull();
  });
});
