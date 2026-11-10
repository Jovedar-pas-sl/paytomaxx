// Las líneas de ayuda del personal (Grafito 2): una por pantalla o paso. El
// nuevo la ve; el veterano la cierra con «Entendido» y esa pantalla deja de
// enseñarla en este móvil. Un «?» pequeño la vuelve a enseñar. Se guarda en
// localStorage, una clave por pantalla. Si el almacenamiento falla (no se
// puede leer ni escribir), la ayuda se sigue viendo: nunca se pierde.

/** Delante de la pantalla en la clave de localStorage: «np-ayuda-cobros». */
export const HELP_KEY_PREFIX = 'np-ayuda-';

/** Lo que se usa de localStorage (en las pruebas, uno de mentira). */
export interface HelpStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** La clave de una pantalla («cobros», «recepcion-importe»…). */
export function helpKey(screen: string): string {
  return `${HELP_KEY_PREFIX}${screen}`;
}

/** ¿Se cerró la ayuda de esta pantalla en este móvil? Sin almacenamiento o si falla, no: se ve. */
export function isHelpHidden(storage: HelpStorage | null, screen: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(helpKey(screen)) === '1';
  } catch {
    return false;
  }
}

/** La cierra (o la vuelve a abrir) en este móvil. false si no se pudo guardar. */
export function saveHelpHidden(storage: HelpStorage | null, screen: string, hidden: boolean): boolean {
  if (!storage) return false;
  try {
    if (hidden) storage.setItem(helpKey(screen), '1');
    else storage.removeItem(helpKey(screen));
    return true;
  } catch {
    return false;
  }
}

export interface HelpStore {
  subscribe(listener: () => void): () => void;
  isHidden(screen: string): boolean;
  /** «Entendido». Devuelve si quedó cerrada (si no se pudo guardar, se sigue viendo). */
  hide(screen: string): boolean;
  /** «?»: la vuelve a enseñar. */
  show(screen: string): void;
}

/**
 * Lo que comparten todas las líneas de ayuda de la app: lo guardado y quién
 * lo mira (la línea y su «?» cambian a la vez). `storage` se pide cada vez:
 * en el navegador, localStorage (que puede no estar).
 */
export function createHelpStore(storage: () => HelpStorage | null): HelpStore {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isHidden: (screen) => isHelpHidden(storage(), screen),
    hide(screen) {
      saveHelpHidden(storage(), screen, true);
      emit();
      // Lo que manda es lo que se lee: si no se guardó, sigue a la vista.
      return isHelpHidden(storage(), screen);
    },
    show(screen) {
      saveHelpHidden(storage(), screen, false);
      emit();
    },
  };
}

/** localStorage del navegador; null en el servidor o si el navegador no lo deja tocar. */
export function browserHelpStorage(): HelpStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
