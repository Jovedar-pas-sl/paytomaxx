import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ¿Por qué se acabó la sesión? Caducada (aquí o en otra pestaña) → si hay un
 * cobro abierto se pide entrar encima; «Salir» en otra pestaña → fuera aquí también.
 */

const TOKEN = 'np_op_token';
const LOGOUT = 'np_op_logout';

/** Almacenamiento en memoria que apunta cada escritura en `log`. */
function fakeStorage(log: string[]): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      log.push(`set:${k}`);
      m.set(k, v);
    },
    removeItem: (k) => {
      log.push(`remove:${k}`);
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

type Listener = (e: Event | StorageEvent) => void;
let storage: Storage;
let listeners: Map<string, Set<Listener>>;
let writes: string[];

async function api() {
  vi.resetModules();
  return import('./api');
}

function fire(type: string, event: Partial<StorageEvent> & { type?: string } = {}) {
  for (const l of listeners.get(type) ?? []) l({ type, ...event } as StorageEvent);
}

beforeEach(() => {
  writes = [];
  storage = fakeStorage(writes);
  storage.setItem(TOKEN, 't');
  storage.setItem('np_op_refresh', 'r');
  writes.length = 0;
  listeners = new Map();
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: (type: string, l: Listener) => {
      listeners.set(type, new Set([...(listeners.get(type) ?? []), l]));
    },
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l),
    dispatchEvent: (e: Event) => {
      fire(e.type);
      return true;
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

describe('sessionEndFromStorage — lo que hizo otra pestaña', () => {
  it('«Salir» deja su marca: es salir, no caducar', async () => {
    const { sessionEndFromStorage } = await api();
    expect(sessionEndFromStorage(LOGOUT, '123-abc', false)).toBe('logout');
    expect(sessionEndFromStorage(LOGOUT, null, false)).toBeNull();
  });

  it('la sesión desaparece sin marca: caducó allí', async () => {
    const { sessionEndFromStorage } = await api();
    expect(sessionEndFromStorage(TOKEN, null, false)).toBe('expired');
  });

  it('almacenamiento borrado entero: fuera', async () => {
    const { sessionEndFromStorage } = await api();
    expect(sessionEndFromStorage(null, null, false)).toBe('logout');
  });

  it('con sesión (renovada o recién entrada) no se acaba nada', async () => {
    const { sessionEndFromStorage } = await api();
    expect(sessionEndFromStorage(TOKEN, 'nuevo', true)).toBeNull();
    expect(sessionEndFromStorage('np_op_user', null, false)).toBeNull();
  });
});

describe('logout — la marca va antes de borrar la sesión', () => {
  it('las otras pestañas ven «Salir» antes que la sesión borrada', async () => {
    const { logout } = await api();
    await logout();
    const mark = writes.indexOf(`set:${LOGOUT}`);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(writes.indexOf(`remove:${TOKEN}`));
  });

  it('cada salida deja una marca distinta (si no, el navegador no avisa)', async () => {
    const { logout } = await api();
    await logout();
    const first = storage.getItem(LOGOUT);
    storage.setItem(TOKEN, 't');
    await logout();
    expect(storage.getItem(LOGOUT)).not.toBe(first);
  });
});

describe('onSessionEnded', () => {
  it('caducada aquí, caducada allí y salir allí', async () => {
    const { onSessionEnded, SESSION_EXPIRED_EVENT } = await api();
    const reasons: string[] = [];
    const stop = onSessionEnded((r) => reasons.push(r));

    fire(SESSION_EXPIRED_EVENT);
    storage.removeItem(TOKEN);
    fire('storage', { key: TOKEN, newValue: null });
    fire('storage', { key: LOGOUT, newValue: 'x' });
    expect(reasons).toEqual(['expired', 'expired', 'logout']);

    stop();
    fire(SESSION_EXPIRED_EVENT);
    expect(reasons).toHaveLength(3);
  });
});
