// «Resolver» un aviso (B11): se marca de verdad pasados 10 s, y hasta
// entonces se puede deshacer. El API no tiene «des-resolver»: el aviso no se
// manda hasta que pasa el tiempo. Si se cierra el panel antes, se manda en
// ese momento (no se pierde lo que el dueño dio por resuelto).

/** Tiempo para deshacer «Resolver». */
export const UNDO_RESOLVE_MS = 10_000;

/** Un aviso marcado que aún se puede deshacer, y hasta cuándo (ms). */
export interface PendingResolve {
  key: string;
  until: number;
}

interface Timers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Acciones que esperan un rato por si se deshacen (una por clave). */
export interface DelayedActions {
  /** La hace pasado `delayMs`; si ya había una con esa clave, la sustituye. */
  schedule: (key: string, run: () => void, delayMs: number) => void;
  /** «Deshacer»: false si ya se hizo (o no había nada). */
  cancel: (key: string) => boolean;
  /** Hace ya todas las que esperan (al cerrar el panel). */
  flush: () => void;
  size: () => number;
}

export function createDelayedActions(timers: Timers = DEFAULT_TIMERS): DelayedActions {
  const waiting = new Map<string, { run: () => void; handle: unknown }>();
  const fire = (key: string): void => {
    const item = waiting.get(key);
    if (!item) return;
    waiting.delete(key);
    item.run();
  };
  return {
    schedule(key, run, delayMs) {
      const previous = waiting.get(key);
      if (previous) timers.clear(previous.handle);
      waiting.set(key, { run, handle: timers.set(() => fire(key), delayMs) });
    },
    cancel(key) {
      const item = waiting.get(key);
      if (!item) return false;
      timers.clear(item.handle);
      waiting.delete(key);
      return true;
    },
    flush() {
      for (const [key, item] of [...waiting]) {
        timers.clear(item.handle);
        fire(key);
      }
    },
    size: () => waiting.size,
  };
}

/** Segundos que quedan para deshacer: «10 s» al empezar y nunca «0 s» mientras se puede. */
export function undoSecondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Letras mínimas de la nota de un aviso de dinero (las mismas que pide el API). */
export const MIN_RESOLVE_NOTE_LENGTH = 3;

/** ¿Se puede marcar como resuelto? Un aviso de dinero, solo con la nota escrita. */
export function resolveNoteOk(noteRequired: boolean, note: string): boolean {
  return !noteRequired || note.trim().length >= MIN_RESOLVE_NOTE_LENGTH;
}
