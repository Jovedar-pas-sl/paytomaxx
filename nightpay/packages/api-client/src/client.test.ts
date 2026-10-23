import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerUnavailableError, SessionExpiredError } from './errors';
import { BASE, USER, device, flush, jwt, json, type Device } from './test-harness';
import { SESSION_EXPIRED_EVENT, type LoginResult, type SessionUser } from './types';

let d: Device;

beforeEach(() => {
  d = device();
});

/** Entra en una pestaña como lo hace el LoginForm: login() y setSession(). */
async function signIn(tab: ReturnType<Device['tab']>): Promise<LoginResult<SessionUser>> {
  const result = await tab.client.login({ email: USER.email, password: 'Clave-de-prueba-1' });
  tab.client.setSession(result);
  return result;
}

describe('login', () => {
  it('con la cookie (credentials: include) y la cabecera propia; el refresh token del cuerpo se ignora', async () => {
    const tab = d.tab();
    const result = await tab.client.login({ email: USER.email, password: 'x' });
    const req = d.api.requests[0]!;
    expect(req.init.credentials).toBe('include');
    expect(new Headers(req.init.headers).get('X-OxioPay-Client')).toBe('1');
    expect(result).not.toHaveProperty('refreshToken');
    expect(result.user.id).toBe('u1');
  });

  it('credenciales malas → ApiError con el estado y el texto del API', async () => {
    const tab = d.tab({ env: { fetch: async () => json(401, { detail: 'Email o contraseña incorrectos' }) } });
    await expect(tab.client.login({ email: 'x@y.es', password: 'z' })).rejects.toMatchObject({
      status: 401,
      message: 'Email o contraseña incorrectos',
    });
  });
});

describe('el access token solo en memoria', () => {
  it('nunca se escribe en localStorage ni sale por el canal entre pestañas', async () => {
    const sessionStorageSpy = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem: sessionStorageSpy, getItem: sessionStorageSpy });
    const tab = d.tab();
    const login = await signIn(tab);
    const refreshed = await tab.client.refreshAccessToken(login.accessToken);
    await tab.client.authedFetch('/v1/operators/me/balance');

    const tokens = [login.accessToken, refreshed];
    for (const { value } of d.storage.writes) {
      for (const t of tokens) expect(value).not.toContain(t);
    }
    for (const message of d.hub.posted) {
      for (const t of tokens) expect(JSON.stringify(message)).not.toContain(t);
    }
    expect(d.storage.writes.map((w) => w.key)).toEqual(['np_op_user']);
    expect(sessionStorageSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('una pestaña nueva (o recargada) no tiene token: lo pide con la cookie al primer uso', async () => {
    await signIn(d.tab());
    const reloaded = d.tab();
    expect(reloaded.client.getAccessToken()).toBeNull();
    expect(reloaded.client.hasSession()).toBe(true);
    const res = await reloaded.client.authedFetch('/v1/operators/me/balance');
    expect(res.status).toBe(200);
    expect(d.api.refreshCalls).toBe(1);
    expect(reloaded.client.getAccessToken()).toEqual(expect.any(String));
  });
});

describe('refresco único (single-flight)', () => {
  it('varias peticiones a la vez sin token → un solo refresco', async () => {
    await signIn(d.tab());
    const tab = d.tab();
    d.api.refreshDelayMs = 20;
    await Promise.all([
      tab.client.authedFetch('/v1/a'),
      tab.client.authedFetch('/v1/b'),
      tab.client.authedFetch('/v1/c'),
    ]);
    expect(d.api.refreshCalls).toBe(1);
  });

  it('varias peticiones caducadas a la vez (401) → un solo refresco y se repiten con el nuevo', async () => {
    const tab = d.tab();
    const login = await signIn(tab);
    d.api.expiredToken = login.accessToken;
    const results = await Promise.all([tab.client.authedFetch('/v1/a'), tab.client.authedFetch('/v1/b')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(d.api.refreshCalls).toBe(1);
  });

  it('dos pestañas a la vez: con Web Locks, de una en una (la cookie nunca se presenta dos veces a la vez)', async () => {
    await signIn(d.tab());
    const a = d.tab();
    const b = d.tab();
    d.api.refreshDelayMs = 10;
    await Promise.all([a.client.authedFetch('/v1/a'), b.client.authedFetch('/v1/b')]);
    const refreshes = d.api.requests.filter((r) => r.path === '/v1/auth/refresh');
    expect(refreshes).toHaveLength(2);
    // Cada una presentó una cookie distinta: la segunda, la que dejó la primera.
    expect(refreshes[0]!.cookie).not.toBe(refreshes[1]!.cookie);
  });
});

describe('401 frente a 429 / 5xx / sin red', () => {
  it('refresco rechazado (401) → SessionExpiredError, evento de la página, se borra lo guardado', async () => {
    const tab = d.tab();
    await signIn(tab);
    tab.client.setAccessToken('caducado');
    d.api.expiredToken = 'caducado';
    d.api.refreshFails = 401;
    await expect(tab.client.authedFetch('/v1/a')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(tab.dispatched).toEqual([SESSION_EXPIRED_EVENT]);
    expect(tab.events).toEqual([{ type: 'expired', source: 'this-tab' }]);
    expect(d.storage.getItem('np_op_user')).toBeNull();
    expect(tab.client.getAccessToken()).toBeNull();
  });

  it.each([429, 500, 503])('refresco con %i → ServerUnavailableError: la sesión sigue', async (status) => {
    const tab = d.tab();
    await signIn(tab);
    tab.client.setAccessToken('caducado');
    d.api.expiredToken = 'caducado';
    d.api.refreshFails = status;
    const err = await tab.client.authedFetch('/v1/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerUnavailableError);
    expect((err as ServerUnavailableError).status).toBe(status);
    expect(tab.dispatched).toEqual([]);
    expect(d.storage.getItem('np_op_user')).not.toBeNull();
  });

  it('sin red al refrescar → ServerUnavailableError (no «sesión caducada»)', async () => {
    const tab = d.tab();
    await signIn(tab);
    tab.client.setAccessToken('caducado');
    d.api.expiredToken = 'caducado';
    d.api.refreshFails = 'network';
    await expect(tab.client.authedFetch('/v1/a')).rejects.toMatchObject({ name: 'ServerUnavailableError', status: 0 });
    expect(tab.dispatched).toEqual([]);
  });

  it('sin red en un endpoint → ServerUnavailableError con status 0', async () => {
    const tab = d.tab({ env: { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) } });
    tab.client.setAccessToken('t');
    await expect(tab.client.authedFetch('/v1/a')).rejects.toMatchObject({ name: 'ServerUnavailableError', status: 0 });
  });

  it('el reintento con token nuevo también da 401 → sesión caducada', async () => {
    const tab = d.tab({
      env: {
        fetch: async (url) =>
          new URL(url).pathname === '/v1/auth/refresh' ? json(200, { accessToken: 'nuevo' }) : json(401, {}),
      },
    });
    tab.client.setAccessToken('viejo');
    await expect(tab.client.authedFetch('/v1/a')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('sin sesión guardada → vuelve al login sin llamar al API', async () => {
    const tab = d.tab();
    await expect(tab.client.authedFetch('/v1/a')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(d.api.requests).toEqual([]);
    expect(tab.dispatched).toEqual([SESSION_EXPIRED_EVENT]);
  });
});

describe('entre pestañas (BroadcastChannel)', () => {
  it('«Salir» en una pestaña saca a las otras (y olvidan su token)', async () => {
    const a = d.tab();
    await signIn(a);
    const b = d.tab();
    await b.client.authedFetch('/v1/a');
    expect(b.client.getAccessToken()).not.toBeNull();

    await expect(a.client.logout()).resolves.toBe(true);
    await flush();
    expect(b.events).toEqual([{ type: 'logout', source: 'other-tab' }]);
    expect(b.client.getAccessToken()).toBeNull();
    expect(d.api.cookie).toBeNull();
  });

  it('la sesión caducó en otra pestaña → esta también', async () => {
    const a = d.tab();
    await signIn(a);
    const b = d.tab();
    b.client.hasSession();
    a.client.setAccessToken('caducado');
    d.api.expiredToken = 'caducado';
    d.api.refreshFails = 401;
    await a.client.authedFetch('/v1/a').catch(() => undefined);
    await flush();
    expect(b.events).toEqual([{ type: 'expired', source: 'other-tab' }]);
    expect(b.dispatched).toEqual([]);
  });

  it('…salvo si esta pestaña entró después de aquel refresco (su sesión es otra)', async () => {
    let clock = 1_000;
    const a = d.tab({ env: { now: () => clock } });
    await signIn(a);
    a.client.setAccessToken('caducado');
    d.api.expiredToken = 'caducado';
    d.api.refreshFails = 401;
    const b = d.tab({ env: { now: () => clock } });
    const failing = a.client.authedFetch('/v1/a').catch(() => undefined);
    clock = 2_000;
    d.api.refreshFails = null;
    await signIn(b); // entra en b mientras el refresco de a ya iba a ser rechazado
    await failing;
    await flush();
    expect(b.events).toEqual([]);
    expect(b.client.getAccessToken()).not.toBeNull();
  });

  it('otra pestaña entra y esta estaba en el login → «signed-in»', async () => {
    const b = d.tab();
    expect(b.client.hasSession()).toBe(false);
    await signIn(d.tab());
    await flush();
    expect(b.events).toEqual([{ type: 'signed-in', source: 'other-tab' }]);
  });

  it('otra persona entra en otra pestaña → «changed» (aquí no se sigue con la sesión de antes)', async () => {
    const a = d.tab();
    await signIn(a);
    const b = d.tab();
    await b.client.authedFetch('/v1/a');
    d.api.person = 'u2';
    await signIn(a);
    await flush();
    expect(b.events).toEqual([{ type: 'changed', source: 'other-tab' }]);
    expect(b.client.getAccessToken()).toBeNull();
  });

  it('la misma persona vuelve a entrar en otra pestaña → nada', async () => {
    const a = d.tab();
    await signIn(a);
    const b = d.tab();
    b.client.hasSession();
    await signIn(a);
    await flush();
    expect(b.events).toEqual([]);
  });

  it('cambio de local (updateUser) → las otras pestañas lo saben', async () => {
    const a = d.tab();
    await signIn(a);
    const b = d.tab();
    b.client.hasSession();
    a.client.updateUser({ ...USER, tenantId: 't2', venueSlug: 'sol' });
    await flush();
    expect(b.events).toEqual([{ type: 'changed', source: 'other-tab' }]);
    expect(b.client.getUser()?.tenantId).toBe('t2');
  });

  it('el refresco devuelve a otra persona (entró en otra pestaña sin canal) → «changed» en esta', async () => {
    const tab = d.tab({ env: { channel: () => null } });
    await signIn(tab);
    d.api.person = 'u2';
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(tab.events).toEqual([{ type: 'changed', source: 'this-tab' }]);
  });
});

describe('el nombre de la sesión, al día con cada refresco', () => {
  it('sesión de antes (sin nombre guardado): el refresco trae el nombre, se guarda y se avisa («profile»)', async () => {
    const tab = d.tab();
    await signIn(tab);
    expect(tab.client.getUser()?.displayName).toBeUndefined();
    d.api.refreshDisplayName = 'Carlos';
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(tab.client.getUser()).toMatchObject({ ...USER, displayName: 'Carlos' });
    expect(tab.events).toEqual([{ type: 'profile', source: 'this-tab' }]);
  });

  it('una pestaña recargada (sin token) lo pone en el primer uso', async () => {
    await signIn(d.tab());
    d.api.refreshDisplayName = 'Carlos';
    const reloaded = d.tab();
    await reloaded.client.authedFetch('/v1/operators/me/balance');
    expect(reloaded.client.getUser()?.displayName).toBe('Carlos');
  });

  it('el mismo nombre: no se escribe nada ni se avisa', async () => {
    const tab = d.tab();
    await signIn(tab);
    d.api.refreshDisplayName = 'Carlos';
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    const writes = d.storage.writes.length;
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(d.storage.writes.length).toBe(writes);
    expect(tab.events).toEqual([{ type: 'profile', source: 'this-tab' }]);
  });

  it('el dueño le quitó el nombre (null): se quita también aquí (la app vuelve al puesto)', async () => {
    const tab = d.tab();
    await signIn(tab);
    d.api.refreshDisplayName = 'Carlos';
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    d.api.refreshDisplayName = null;
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(tab.client.getUser()?.displayName).toBeNull();
  });

  it('un API de antes (sin el campo) no toca el nombre guardado', async () => {
    const tab = d.tab();
    await signIn(tab);
    tab.client.updateUser({ ...USER, displayName: 'Carlos' });
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(tab.client.getUser()?.displayName).toBe('Carlos');
    expect(tab.events).toEqual([]);
  });

  it('el refresco es de otra persona: su nombre no se mezcla con la sesión guardada', async () => {
    const tab = d.tab({ env: { channel: () => null } });
    await signIn(tab);
    d.api.person = 'u2';
    d.api.refreshDisplayName = 'Otra';
    await tab.client.refreshAccessToken(tab.client.getAccessToken());
    expect(tab.client.getUser()?.displayName).toBeUndefined();
    expect(tab.events).toEqual([{ type: 'changed', source: 'this-tab' }]);
  });
});

describe('logout', () => {
  it('borra todo aquí antes de esperar a la red y cierra en el API con la cookie', async () => {
    const tab = d.tab();
    await signIn(tab);
    const done = tab.client.logout();
    expect(tab.client.getAccessToken()).toBeNull();
    expect(d.storage.getItem('np_op_user')).toBeNull();
    await expect(done).resolves.toBe(true);
    const req = d.api.requests.at(-1)!;
    expect(req.path).toBe('/v1/auth/logout');
    expect(req.init.credentials).toBe('include');
    expect(new Headers(req.init.headers).get('X-OxioPay-Client')).toBe('1');
    expect(JSON.parse(String(req.init.body))).toEqual({});
  });

  it('sin red o el API no lo confirma: sale igual y lo dice (false)', async () => {
    const tab = d.tab({ env: { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) } });
    tab.client.setSession({ accessToken: 'a', expiresIn: 1, user: USER });
    await expect(tab.client.logout()).resolves.toBe(false);
    expect(d.storage.getItem('np_op_user')).toBeNull();
  });

  it('salir mientras un refresco va de camino: lo que vuelve no resucita la sesión', async () => {
    const tab = d.tab();
    await signIn(tab);
    d.api.refreshDelayMs = 20;
    const refreshing = tab.client.refreshAccessToken(tab.client.getAccessToken()).catch((e: unknown) => e);
    await tab.client.logout();
    expect(await refreshing).toBeInstanceOf(SessionExpiredError);
    expect(tab.client.getAccessToken()).toBeNull();
    expect(tab.dispatched).toEqual([]);
  });
});

describe('sesión de la versión antigua (tokens en localStorage)', () => {
  beforeEach(() => {
    d.storage.setItem('np_op_token', 'access-viejo');
    d.storage.setItem('np_op_refresh', 'refresh-viejo-0123456789');
    d.storage.setItem('np_op_user', JSON.stringify(USER));
  });

  it('el primer refresco la pasa a la cookie (token en el cuerpo) y borra los tokens guardados', async () => {
    const tab = d.tab();
    expect(tab.client.hasSession()).toBe(true);
    await tab.client.authedFetch('/v1/a');
    const refresh = d.api.requests.find((r) => r.path === '/v1/auth/refresh')!;
    expect(JSON.parse(String(refresh.init.body))).toEqual({ refreshToken: 'refresh-viejo-0123456789' });
    expect(d.storage.getItem('np_op_refresh')).toBeNull();
    expect(d.storage.getItem('np_op_token')).toBeNull();
    expect(d.storage.getItem('np_op_user')).not.toBeNull();
  });

  it('si el API no contesta (503), los conserva para el próximo intento', async () => {
    d.api.refreshFails = 503;
    const tab = d.tab();
    await expect(tab.client.authedFetch('/v1/a')).rejects.toBeInstanceOf(ServerUnavailableError);
    expect(d.storage.getItem('np_op_refresh')).toBe('refresh-viejo-0123456789');
  });

  it('si el API la rechaza (fecha pasada), se borra y hay que entrar', async () => {
    d.api.refreshFails = 401;
    const tab = d.tab();
    await expect(tab.client.authedFetch('/v1/a')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(d.storage.getItem('np_op_refresh')).toBeNull();
  });

  it('sin la pista de quién es (el TPV antiguo no la guardaba): se apunta la del token', async () => {
    d.storage.removeItem('np_op_user');
    const tab = d.tab();
    expect(tab.client.hasSession()).toBe(true);
    await tab.client.authedFetch('/v1/a');
    expect(tab.client.getUser()).toMatchObject({ id: 'u1', tenantId: 't1', venueSlug: 'luna' });
  });
});

describe('afterRefresh y freshAccessToken', () => {
  it('afterRefresh puede cambiar el token (el super-admin vuelve a su local)', async () => {
    await signIn(d.tab());
    const tab = d.tab({ afterRefresh: async () => 'del-local-elegido' });
    await expect(tab.client.refreshAccessToken(null)).resolves.toBe('del-local-elegido');
  });

  it('freshAccessToken: el vigente si le queda; si caduca ya, uno nuevo; sin sesión, null', async () => {
    const now = Date.now();
    const tab = d.tab();
    expect(await tab.client.freshAccessToken()).toBeNull();
    const lasting = jwt({ sub: 'u1', exp: Math.floor(now / 1000) + 3600 });
    tab.client.setSession({ accessToken: lasting, expiresIn: 3600, user: USER });
    expect(await tab.client.freshAccessToken()).toBe(lasting);
    d.api.cookie = 'rt-x';
    tab.client.setAccessToken(jwt({ sub: 'u1', exp: Math.floor(now / 1000) + 10 }));
    const fresh = await tab.client.freshAccessToken();
    expect(fresh).not.toBe(lasting);
    expect(d.api.refreshCalls).toBe(1);
  });
});

describe('tiempo máximo', () => {
  it('sin respuesta en el tiempo máximo → ServerUnavailableError(timeout)', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const tab = d.tab({ requestTimeoutMs: 20, env: { fetch: hang } });
    await expect(tab.client.publicFetch('/v1/x')).rejects.toMatchObject({ name: 'ServerUnavailableError', reason: 'timeout' });
  });

  it('quien llama cancela (AbortController) → su AbortError tal cual', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const tab = d.tab({ env: { fetch: hang } });
    tab.client.setAccessToken('t');
    const controller = new AbortController();
    const pending = tab.client.authedFetch('/v1/x', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cada petición puede pedir más tiempo (descargas)', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const tab = d.tab({
      requestTimeoutMs: 1,
      env: {
        fetch: async (_url, init) => {
          seen.push(init?.signal);
          await new Promise((r) => setTimeout(r, 10));
          return json(200, {});
        },
      },
    });
    tab.client.setAccessToken('t');
    await expect(tab.client.authedFetch('/v1/export', {}, { timeoutMs: 1_000 })).resolves.toMatchObject({ status: 200 });
    expect(seen[0]?.aborted).toBe(false);
  });
});

describe('peticiones', () => {
  it('authedFetch: Bearer, credentials include y Content-Type JSON si hay cuerpo de texto', async () => {
    const calls: RequestInit[] = [];
    const tab = d.tab({
      env: {
        fetch: async (_url, init = {}) => {
          calls.push(init);
          return json(200, {});
        },
      },
    });
    tab.client.setAccessToken('tok');
    await tab.client.authedFetch('/v1/x', { method: 'POST', body: '{}' });
    const headers = new Headers(calls[0]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(calls[0]!.credentials).toBe('include');
  });

  it('la URL base sin barra final', async () => {
    const urls: string[] = [];
    const tab = d.tab({
      baseUrl: `${BASE}/`,
      env: {
        fetch: async (url) => {
          urls.push(url);
          return json(200, {});
        },
      },
    });
    await tab.client.publicFetch('/v1/payments/public/x');
    expect(urls).toEqual([`${BASE}/v1/payments/public/x`]);
  });
});
