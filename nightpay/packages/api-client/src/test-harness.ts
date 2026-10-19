// Solo para las pruebas: un API de mentira (con su cookie), Web Locks y
// BroadcastChannel compartidos entre "pestañas" (clientes) y un localStorage
// que apunta cada escritura.

import { createApiClient } from './client';
import type { BroadcastChannelLike, ChannelFactory } from './tab-channel';
import type { ApiClient, ApiClientConfig, LockManagerLike, SessionEvent, SessionUser } from './types';

export const BASE = 'https://api.test';

export function jwt(claims: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `h.${b64}.firma`;
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface LoggedStorage extends Storage {
  readonly writes: Array<{ key: string; value: string }>;
}

export function loggedStorage(): LoggedStorage {
  const m = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  return {
    writes,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      writes.push({ key: k, value: String(v) });
      m.set(k, String(v));
    },
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

/** Un candado por nombre, compartido por todas las pestañas: de una en una. */
export function sharedLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, callback) {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(callback, callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

/** BroadcastChannel de mentira: lo que manda una pestaña lo reciben las otras (no ella). */
export function channelHub(): { factory: ChannelFactory; posted: unknown[] } {
  const members = new Map<string, Set<FakeChannel>>();
  const posted: unknown[] = [];

  class FakeChannel implements BroadcastChannelLike {
    private readonly listeners = new Set<(e: MessageEvent) => void>();
    constructor(private readonly name: string) {
      const set = members.get(name) ?? new Set<FakeChannel>();
      set.add(this);
      members.set(name, set);
    }
    postMessage(message: unknown): void {
      posted.push(message);
      for (const other of members.get(this.name) ?? []) {
        // Como el de verdad: llega después, y como copia.
        if (other !== this) setTimeout(() => other.deliver(structuredClone(message)), 0);
      }
    }
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void): void {
      this.listeners.add(listener);
    }
    close(): void {
      members.get(this.name)?.delete(this);
    }
    deliver(data: unknown): void {
      for (const l of this.listeners) l({ data } as MessageEvent);
    }
  }

  return { factory: (name) => new FakeChannel(name), posted };
}

export const USER: SessionUser = {
  id: 'u1',
  email: 'ana@local.es',
  role: 'OPERATOR',
  tenantId: 't1',
  venueSlug: 'luna',
};

/** El API de mentira: una cookie de sesión que rota en cada refresco. */
export class FakeApi {
  cookie: string | null = null;
  private serial = 0;
  refreshCalls = 0;
  /** Lo que mandó cada petición al API (para comprobar cabeceras y cuerpos). */
  readonly requests: Array<{ path: string; init: RequestInit; cookie: string | null }> = [];
  /** Respuesta forzada del refresco (status), o un error de red. */
  refreshFails: number | 'network' | null = null;
  refreshDelayMs = 0;
  /** Token que da 401 en los endpoints (el "caducado"). */
  expiredToken: string | null = null;
  person = 'u1';

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname;
    this.requests.push({ path, init, cookie: this.cookie });
    if (path === '/v1/auth/login') return this.login();
    if (path === '/v1/auth/refresh') return this.refresh(init);
    if (path === '/v1/auth/logout') {
      this.cookie = null;
      return new Response(null, { status: 204 });
    }
    const auth = new Headers(init.headers).get('Authorization');
    if (!auth || auth === `Bearer ${this.expiredToken}`) return json(401, { detail: 'caducado' });
    return json(200, { ok: true, auth });
  };

  token(): string {
    this.serial += 1;
    return jwt({ sub: this.person, tenantId: 't1', email: 'ana@local.es', role: 'OPERATOR', venueSlug: 'luna', n: this.serial });
  }

  private login(): Response {
    this.cookie = `rt-${this.serial + 1}`;
    return json(200, { accessToken: this.token(), expiresIn: 3600, refreshExpiresIn: 2_592_000, refreshToken: 'NO-SE-USA', user: { ...USER, id: this.person } });
  }

  private async refresh(init: RequestInit): Promise<Response> {
    this.refreshCalls += 1;
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.refreshFails === 'network') throw new TypeError('Failed to fetch');
    if (this.refreshFails) return json(this.refreshFails, {});
    const body = JSON.parse(String(init.body ?? '{}')) as { refreshToken?: string };
    if (!this.cookie && !body.refreshToken) return json(401, { detail: 'sin sesión' });
    this.cookie = `rt-${this.serial + 1}`;
    return json(200, { accessToken: this.token(), expiresIn: 3600, refreshExpiresIn: 2_592_000 });
  }
}

export interface Tab {
  readonly client: ApiClient;
  readonly events: SessionEvent[];
  readonly dispatched: string[];
}

export interface Device {
  readonly api: FakeApi;
  readonly storage: LoggedStorage;
  readonly locks: LockManagerLike;
  readonly hub: ReturnType<typeof channelHub>;
  /** Una pestaña nueva de la app (comparte almacenamiento, candado, canal y cookie). */
  tab(extra?: Partial<ApiClientConfig>): Tab;
}

export function device(): Device {
  const api = new FakeApi();
  const storage = loggedStorage();
  const locks = sharedLocks();
  const hub = channelHub();
  return {
    api,
    storage,
    locks,
    hub,
    tab(extra = {}) {
      const dispatched: string[] = [];
      const events: SessionEvent[] = [];
      const client = createApiClient({
        baseUrl: BASE,
        storagePrefix: 'np_op',
        ...extra,
        env: {
          fetch: api.fetch,
          storage: () => storage,
          locks: () => locks,
          channel: hub.factory,
          dispatch: (type) => void dispatched.push(type),
          ...extra.env,
        },
      });
      client.onSessionEvent((e) => events.push(e));
      return { client, events, dispatched };
    },
  };
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
