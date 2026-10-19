import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Renovar la sesión: la chica no se queda fuera porque varias peticiones (o
 * pestañas) caduquen a la vez, ni porque el API esté desplegándose. El
 * refresh token va en la cookie del API: aquí solo se ve que la petición la
 * lleva (credentials: 'include' y la cabecera propia).
 */

const USER = 'np_op_user';

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
let dispatched: string[];

async function api() {
  vi.resetModules();
  return import('./api');
}

beforeEach(() => {
  storage = fakeStorage();
  // Sesión de antes de recargar: solo quién es (el token no se guarda).
  storage.setItem(USER, JSON.stringify({ id: 'u1', tenantId: 't1', email: 'ana@local.es', role: 'OPERATOR', venueSlug: 'luna' }));
  dispatched = [];
  vi.stubGlobal('window', {
    localStorage: storage,
    dispatchEvent: (e: Event) => {
      dispatched.push(e.type);
      return true;
    },
  });
  vi.stubGlobal('BroadcastChannel', undefined);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

const isRefresh = (url: string) => url.endsWith('/v1/auth/refresh');

/** El API: 401 con el token viejo, 200 con cualquier otro. */
function balanceRoute(url: string, init?: RequestInit): Response | null {
  if (!url.endsWith('/v1/operators/me/balance')) return null;
  const auth = new Headers(init?.headers).get('Authorization');
  return auth === 'Bearer viejo' ? json(401, {}) : json(200, { pendingCents: 0 });
}

/** Una sesión con el token "viejo" en memoria, como tras entrar hace una hora. */
async function withOldToken() {
  const mod = await api();
  mod.setSession({
    accessToken: 'viejo',
    expiresIn: 3600,
    user: { id: 'u1', email: 'ana@local.es', role: 'OPERATOR', tenantId: 't1', venueSlug: 'luna' },
  });
  return mod;
}

describe('renovar la sesión', () => {
  it('al recargar no hay token: lo pide con la cookie (una vez aunque haya varias peticiones)', async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (isRefresh(url)) {
        refreshes += 1;
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('X-OxioPay-Client')).toBe('1');
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { accessToken: 'nuevo' });
      }
      return balanceRoute(url, init)!;
    });
    const { fetchBalance, getToken } = await api();
    await Promise.all([fetchBalance(), fetchBalance(), fetchBalance()]);
    expect(refreshes).toBe(1);
    expect(getToken()).toBe('nuevo');
  });

  it('varias peticiones caducadas a la vez → un solo refresh', async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (isRefresh(url)) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { accessToken: 'nuevo' });
      }
      return balanceRoute(url, init)!;
    });
    const { fetchBalance } = await withOldToken();
    await Promise.all([fetchBalance(), fetchBalance(), fetchBalance()]);
    expect(refreshes).toBe(1);
  });

  it('el token nunca se guarda en el almacenamiento', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      isRefresh(url) ? json(200, { accessToken: 'nuevo' }) : balanceRoute(url, init)!,
    );
    const { fetchBalance } = await withOldToken();
    await fetchBalance();
    for (let i = 0; i < storage.length; i++) {
      const value = storage.getItem(storage.key(i)!) ?? '';
      expect(value).not.toContain('viejo');
      expect(value).not.toContain('nuevo');
    }
  });

  it('el API caído o desplegando (503) no cierra la sesión: «servidor no disponible»', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      isRefresh(url) ? json(503, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance, ServerUnavailableError } = await withOldToken();
    await expect(fetchBalance()).rejects.toBeInstanceOf(ServerUnavailableError);
    expect(storage.getItem(USER)).not.toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('sin red: «servidor no disponible», no «sesión caducada»', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { fetchBalance, ServerUnavailableError } = await api();
    await expect(fetchBalance()).rejects.toBeInstanceOf(ServerUnavailableError);
    expect(storage.getItem(USER)).not.toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('refresh rechazado de verdad (401) → se cierra la sesión y la app vuelve al login', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      isRefresh(url) ? json(401, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance, SessionExpiredError, SESSION_EXPIRED_EVENT, getToken } = await withOldToken();
    await expect(fetchBalance()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(storage.getItem(USER)).toBeNull();
    expect(getToken()).toBeNull();
    expect(dispatched).toEqual([SESSION_EXPIRED_EVENT]);
  });

  it('sin sesión guardada (se cerró en otra pestaña) → vuelve al login', async () => {
    storage.clear();
    const { fetchBalance, SessionExpiredError, SESSION_EXPIRED_EVENT } = await api();
    await expect(fetchBalance()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatched).toEqual([SESSION_EXPIRED_EVENT]);
  });

  it('la sesión de la versión anterior (tokens en localStorage) pasa a la cookie sin volver a entrar', async () => {
    storage.setItem('np_op_token', 'access-de-antes');
    storage.setItem('np_op_refresh', 'refresh-de-antes-0123456789');
    const bodies: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (isRefresh(url)) {
        bodies.push(JSON.parse(String(init?.body)));
        return json(200, { accessToken: 'nuevo' });
      }
      return balanceRoute(url, init)!;
    });
    const { fetchBalance } = await api();
    await expect(fetchBalance()).resolves.toEqual({ pendingCents: 0 });
    expect(bodies).toEqual([{ refreshToken: 'refresh-de-antes-0123456789' }]);
    expect(storage.getItem('np_op_refresh')).toBeNull();
    expect(storage.getItem('np_op_token')).toBeNull();
  });
});

describe('salir', () => {
  const noContent = () => new Response(null, { status: 204 });

  it('cierra la sesión local al momento y la del servidor con la cookie', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return noContent();
    });
    const { logout, getToken } = await withOldToken();
    const done = logout();
    // Borrada antes de esperar a la red.
    expect(getToken()).toBeNull();
    expect(storage.getItem(USER)).toBeNull();
    await expect(done).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v1\/auth\/logout$/);
    expect(calls[0]!.init?.credentials).toBe('include');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBeNull();
  });

  it('el servidor no lo confirma (o no hay red): sale igual y lo dice', async () => {
    fetchMock.mockResolvedValue(json(403, {}));
    const { logout } = await withOldToken();
    await expect(logout()).resolves.toBe(false);
    expect(storage.getItem(USER)).toBeNull();

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(logout()).resolves.toBe(false);
  });
});

describe('el refresh limitado (429) o con 403', () => {
  it('429: demasiadas peticiones no es una sesión caducada', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      isRefresh(url) ? json(429, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance, ServerUnavailableError } = await withOldToken();
    await expect(fetchBalance()).rejects.toBeInstanceOf(ServerUnavailableError);
    expect(storage.getItem(USER)).not.toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('403: el API dice que no → vuelve al login', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      isRefresh(url) ? json(403, {}) : balanceRoute(url, init)!,
    );
    const { fetchBalance, SessionExpiredError } = await withOldToken();
    await expect(fetchBalance()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(storage.getItem(USER)).toBeNull();
  });
});
