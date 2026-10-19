import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lo propio del panel sobre el cliente común: los textos del login, el
 * super-admin que vuelve a su local elegido tras refrescar y los avisos de
 * otras pestañas.
 */

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

function jwt(claims: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`;
}

let storage: Storage;
let fetchMock: ReturnType<typeof vi.fn>;
const reload = vi.fn();

async function http() {
  vi.resetModules();
  return import('./http');
}

beforeEach(() => {
  storage = fakeStorage();
  reload.mockClear();
  vi.stubGlobal('window', {
    localStorage: storage,
    dispatchEvent: () => true,
    location: { reload },
  });
  vi.stubGlobal('BroadcastChannel', undefined);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

const SUPER = {
  id: 'u1',
  email: 'jefe@local.es',
  role: 'OWNER',
  tenantId: 'elegido',
  venueSlug: 'sol',
  isSuperAdmin: true,
};

describe('login', () => {
  it('sin red → ApiError con status 0 y el texto de siempre', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { login } = await http();
    const { ApiError, NETWORK_ERROR_MESSAGE } = await import('./api-errors');
    const err = await login('a@b.es', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, message: NETWORK_ERROR_MESSAGE });
  });

  it('credenciales malas o bloqueo → los textos del panel', async () => {
    const { login } = await http();
    fetchMock.mockResolvedValueOnce(json(401, { detail: 'Email o contraseña incorrectos' }));
    await expect(login('a@b.es', 'x')).rejects.toMatchObject({ status: 401, message: 'Email o contraseña incorrectos.' });
    fetchMock.mockResolvedValueOnce(json(429, {}));
    await expect(login('a@b.es', 'x')).rejects.toMatchObject({ status: 429, message: /Demasiados intentos/ });
  });
});

describe('super-admin: tras refrescar vuelve al local que había elegido', () => {
  it('el refresh da el token de su local de siempre → pide el elegido (switch-tenant) sin recargar', async () => {
    storage.setItem('np_admin_user', JSON.stringify(SUPER));
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/v1/auth/refresh') return json(200, { accessToken: jwt({ sub: 'u1', tenantId: 'de-siempre' }) });
      if (path === '/v1/auth/switch-tenant') {
        expect(JSON.parse(String(init?.body))).toEqual({ tenantId: 'elegido' });
        return json(200, { accessToken: jwt({ sub: 'u1', tenantId: 'elegido' }) });
      }
      return json(200, { auth: new Headers(init?.headers).get('Authorization') });
    });
    const { authedFetch, getToken } = await http();
    const res = await authedFetch('/v1/venues/me');
    expect(calls).toEqual(['/v1/auth/refresh', '/v1/auth/switch-tenant', '/v1/venues/me']);
    expect((await res.json()).auth).toBe(`Bearer ${getToken()}`);
    expect(reload).not.toHaveBeenCalled();
  });

  it('quien no es super-admin y el token es de otro local: se corrige el local guardado y se recarga', async () => {
    storage.setItem('np_admin_user', JSON.stringify({ ...SUPER, isSuperAdmin: false }));
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === '/v1/auth/refresh'
        ? json(200, { accessToken: jwt({ sub: 'u1', tenantId: 'de-siempre', venueSlug: 'luna' }) })
        : json(200, {}),
    );
    const { authedFetch, getUser } = await http();
    await authedFetch('/v1/venues/me');
    expect(getUser()).toMatchObject({ tenantId: 'de-siempre', venueSlug: 'luna' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('cambio de local', () => {
  it('applySwitchedTenant: token nuevo en esta pestaña y local nuevo guardado (sin token en el almacenamiento)', async () => {
    storage.setItem('np_admin_user', JSON.stringify(SUPER));
    const { applySwitchedTenant, getToken, getUser } = await http();
    applySwitchedTenant({ accessToken: 'token-del-otro-local', tenantId: 't9', venueSlug: 'mar' });
    expect(getToken()).toBe('token-del-otro-local');
    expect(getUser()).toMatchObject({ tenantId: 't9', venueSlug: 'mar' });
    expect(storage.getItem('np_admin_user')).not.toContain('token-del-otro-local');
  });
});

describe('errores del API', () => {
  it('apiError: un código TOTP_* da TotpError (que es ApiError); totpAwareError lo pasa a castellano', async () => {
    const { apiError, totpAwareError } = await http();
    const { ApiError } = await import('./api-errors');
    const { TotpError } = await import('@nightpay/api-client');
    const err = await apiError(json(403, { detail: 'TOTP required', code: 'TOTP_REQUIRED' }));
    expect(err).toBeInstanceOf(TotpError);
    expect(err).toBeInstanceOf(ApiError);
    const human = await totpAwareError(json(403, { detail: 'TOTP required', code: 'TOTP_REQUIRED' }));
    expect(human).toBeInstanceOf(TotpError);
    expect(human.message).toMatch(/código de tu app/);
  });
});
