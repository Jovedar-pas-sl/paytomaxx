// localStorage sin sustos: modo privado, almacenamiento lleno o bloqueado no
// rompen la app. Aquí solo va lo NO secreto (quién es la sesión, para pintar
// la pantalla): los tokens nunca.

export interface LocalStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(...keys: string[]): void;
}

export function createLocalStore(getStorage: () => Storage | undefined): LocalStore {
  function storage(): Storage | undefined {
    try {
      return getStorage();
    } catch {
      return undefined;
    }
  }
  return {
    get(key) {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(key, value);
      } catch {
        // Sin almacenamiento: la sesión sigue en esta pestaña; al recargar habrá que entrar.
      }
    },
    remove(...keys) {
      const s = storage();
      for (const key of keys) {
        try {
          s?.removeItem(key);
        } catch {
          // Igual que arriba.
        }
      }
    },
  };
}

export const browserStorage = (): Storage | undefined =>
  typeof window !== 'undefined' ? window.localStorage : undefined;
