import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Renovar la sesión: la chica no se queda fuera porque varias peticiones (o
 * pestañas) caduquen a la vez, ni porque el API esté desplegándose.
 */

const TOKEN = 'np_op_token';
const REFRESH = 'np_op_refresh';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let storage: Storage;
let fetchMock: ReturnType<typeof vi.fn>;

async function api() {
  vi.resetModules();
  return import('./api');
}

beforeEach(() => {
  storage = fakeStorage();
  storage.setItem(TOKEN, 'viejo');
  storage.setItem(REFRESH, 'r1');
  storage.setItem('np_op_user', JSON.stringify({ id: 'u1' }));
  vi.stubGlobal('window', { localStorage: storage });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

/** El API: 401 con el token viejo, 200 con cualquier otro. */
function balanceRoute(url: string, init?: RequestInit): Response | null {
  if (!url.endsWith('/v1/operators/me/balance')) return null;
  const auth = new Headers(init?.headers).get('Authorization');
  return auth === 'Bearer viejo' ? json(401, {}) : json(200, { pendingCents: 0 });
}

describe('renovar la sesión', () => {
  it('varias peticiones caducadas a la vez → un solo refresh', async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { accessToken: 'nuevo', refreshToken: 'r2' });
      }
      return balanceRoute(url, init)!;
    });
    const { fetchBalance } = await api();
    await Promise.all([fetchBalance(), fetchBalance(), fetchBalance()]);
    expect(refreshes).toBe(1);
    expect(storage.getItem(TOKEN)).toBe('nuevo');
  });

  it('otra pestaña ya lo renovó (el API dice que el refresh está gastado) → usa el suyo y no cierra sesión', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) {
        // Mientras, la otra pestaña guardó su token nuevo.
        storage.setItem(TOKEN, 'de-la-otra');
        storage.setItem(REFRESH, 'r2');
        return json(401, {});
      }
      return balanceRoute(url, init)!;
    });
    const { fetchBalance } = await api();
    await expect(fetchBalance()).resolves.toEqual({ pendingCents: 0 });
    expect(storage.getItem(TOKEN)).toBe('de-la-otra');
  });

  it('el API caído o desplegando (503) no cierra la sesión', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/v1/auth/refresh') ? json(503, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance } = await api();
    await expect(fetchBalance()).rejects.toThrow('Sesión expirada');
    expect(storage.getItem(REFRESH)).toBe('r1');
  });

  it('refresh rechazado de verdad (401) → se cierra la sesión', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/v1/auth/refresh') ? json(401, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance } = await api();
    await expect(fetchBalance()).rejects.toThrow('Sesión expirada');
    expect(storage.getItem(REFRESH)).toBeNull();
    expect(storage.getItem(TOKEN)).toBeNull();
  });
});
