import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ¿Por qué se acabó la sesión? Caducada (aquí o en otra pestaña) → si hay un
 * cobro abierto se pide entrar encima; «Salir» en otra pestaña, o entró otra
 * persona en otra pestaña → fuera aquí también. Los avisos entre pestañas van
 * por BroadcastChannel (aquí, uno de mentira compartido por las "pestañas").
 */

const USER = { id: 'u1', email: 'ana@local.es', role: 'OPERATOR' as const, tenantId: 't1', venueSlug: 'luna' };

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

/** BroadcastChannel de mentira: lo que manda una instancia lo reciben las demás del mismo nombre, después. */
function fakeBroadcastChannel() {
  const members = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    private readonly listeners = new Set<(e: { data: unknown }) => void>();
    constructor(private readonly name: string) {
      members.set(name, new Set([...(members.get(name) ?? []), this]));
    }
    postMessage(data: unknown) {
      for (const other of members.get(this.name) ?? []) {
        if (other !== this) setTimeout(() => other.listeners.forEach((l) => l({ data: structuredClone(data) })), 0);
      }
    }
    addEventListener(_type: string, l: (e: { data: unknown }) => void) {
      this.listeners.add(l);
    }
    close() {
      members.get(this.name)?.delete(this);
    }
  }
  return FakeChannel;
}

let storage: Storage;
let dispatched: string[];
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Una pestaña de la app: su propia copia del módulo (memoria), mismo almacenamiento y canal. */
async function tab() {
  vi.resetModules();
  return import('./api');
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  storage = fakeStorage();
  dispatched = [];
  vi.stubGlobal('window', {
    localStorage: storage,
    dispatchEvent: (e: Event) => {
      dispatched.push(e.type);
      return true;
    },
  });
  vi.stubGlobal('BroadcastChannel', fakeBroadcastChannel());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});

describe('sessionEndReason — qué hace la app con cada aviso', () => {
  it('caducada aquí o en otra pestaña: «expired» (con cobro abierto, se entra encima)', async () => {
    const { sessionEndReason } = await tab();
    expect(sessionEndReason({ type: 'expired', source: 'this-tab' })).toBe('expired');
    expect(sessionEndReason({ type: 'expired', source: 'other-tab' })).toBe('expired');
  });

  it('«Salir» en otra pestaña u otra persona entró allí: «logout»', async () => {
    const { sessionEndReason } = await tab();
    expect(sessionEndReason({ type: 'logout', source: 'other-tab' })).toBe('logout');
    expect(sessionEndReason({ type: 'changed', source: 'other-tab' })).toBe('logout');
  });

  it('otra pestaña entró y esta no tenía sesión: nada se acaba', async () => {
    const { sessionEndReason } = await tab();
    expect(sessionEndReason({ type: 'signed-in', source: 'other-tab' })).toBeNull();
  });
});

describe('onSessionEnded', () => {
  it('«Salir» en otra pestaña → fuera aquí también', async () => {
    const a = await tab();
    a.setSession({ accessToken: 'ta', expiresIn: 3600, user: USER });
    const b = await tab();
    const reasons: string[] = [];
    const stop = b.onSessionEnded((r) => reasons.push(r));
    expect(b.hasSession()).toBe(true);

    await a.logout();
    await flush();
    expect(reasons).toEqual(['logout']);
    stop();
  });

  it('caducada aquí (el API rechaza el refresco) y caducada en otra pestaña', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/v1/auth/refresh') ? json(401, {}) : json(401, {}))),
    );
    const a = await tab();
    a.setSession({ accessToken: 'ta', expiresIn: 3600, user: USER });
    const b = await tab();
    b.hasSession();
    const here: string[] = [];
    const there: string[] = [];
    a.onSessionEnded((r) => here.push(r));
    const stop = b.onSessionEnded((r) => there.push(r));

    await a.fetchBalance().catch(() => undefined);
    await flush();
    expect(here).toEqual(['expired']);
    expect(dispatched).toContain(a.SESSION_EXPIRED_EVENT);
    expect(there).toEqual(['expired']);

    stop();
  });

  it('otra persona entra en otra pestaña → esta sale (no sigue con la sesión de otra)', async () => {
    const a = await tab();
    a.setSession({ accessToken: 'ta', expiresIn: 3600, user: USER });
    const b = await tab();
    b.hasSession();
    const reasons: string[] = [];
    b.onSessionEnded((r) => reasons.push(r));

    a.setSession({ accessToken: 'tb', expiresIn: 3600, user: { ...USER, id: 'u2' } });
    await flush();
    expect(reasons).toEqual(['logout']);
  });

  it('el refresco trae su nombre (sesión de antes): onProfileUpdated lo da para pintarlo, sin volver a entrar', async () => {
    const claims = { sub: 'u1', email: USER.email, role: 'WAITER', tenantId: 't1', venueSlug: 'luna' };
    const token = `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.f`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/v1/auth/refresh')
          ? json(200, { accessToken: token, expiresIn: 900, refreshExpiresIn: 2_592_000, displayName: 'Carlos' })
          : json(200, { pendingCents: 0, paidCents: 0, lifetimeGrossCents: 0, count: 0 }),
      ),
    );
    const a = await tab();
    a.setSession({ accessToken: 'ta', expiresIn: 3600, user: { ...USER, role: 'WAITER' } });
    const b = await tab(); // la app recién abierta: sin token, lo pide con la cookie
    const names: Array<string | null | undefined> = [];
    const ended: string[] = [];
    b.onSessionEnded((r) => ended.push(r));
    const stop = b.onProfileUpdated((u) => names.push(u.displayName));
    await b.fetchBalance();
    expect(names).toEqual(['Carlos']);
    expect(b.getUser()).toMatchObject({ id: 'u1', role: 'WAITER', displayName: 'Carlos' });
    expect(ended).toEqual([]); // no es el final de la sesión
    stop();
  });

  it('dejar de escuchar', async () => {
    const a = await tab();
    a.setSession({ accessToken: 'ta', expiresIn: 3600, user: USER });
    const b = await tab();
    b.hasSession();
    const reasons: string[] = [];
    const stop = b.onSessionEnded((r) => reasons.push(r));
    stop();
    await a.logout();
    await flush();
    expect(reasons).toEqual([]);
  });
});
