// El aviso flotante (Toast): lo puro. Qué se enseña (uno cada vez), cuánto
// dura y a qué altura se pone. Sin pantalla: se prueba sin navegador.

/** El botón del aviso («Deshacer»). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Solo lo que salió bien o una nota: un error nunca flota ni se va solo (va en un FormError o en un Banner). */
  tone?: 'success' | 'info';
  action?: ToastAction;
}

export interface ToastItem {
  /** Cambia con cada aviso: el reloj empieza de cero. */
  key: number;
  text: string;
  tone: 'success' | 'info';
  action?: ToastAction;
}

/** Lo que dura a la vista. */
export const TOAST_MS = 5000;
/** Con un botón («Deshacer»), el doble: hay que llegar a tocarlo. */
export const TOAST_ACTION_MS = 10000;

let current: ToastItem | null = null;
let lastKey = 0;
const listeners = new Set<() => void>();

function set(next: ToastItem | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** El aviso que se ve ahora (uno solo: el nuevo sustituye al anterior). Lo pinta <Toast /> y lo usa useToast(). */
export const toastStore = {
  get: (): ToastItem | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Hasta 30 letras; con botón, hasta 18 (si no cabe, pasa a dos líneas). */
  show(text: string, options: ToastOptions = {}): void {
    lastKey += 1;
    set({ key: lastKey, text, tone: options.tone ?? 'info', action: options.action });
  },
  /** Lo quita. Con `key`, solo si sigue siendo ese (el reloj de uno anterior no se lleva al nuevo). */
  dismiss(key?: number): void {
    if (current && (key === undefined || current.key === key)) set(null);
  },
};

/** El hueco entre el aviso y el pie que tiene debajo. */
const TOAST_GAP = 16;
/** Lo que necesita el aviso para caber debajo de un pie: su alto mínimo (48) y un hueco a cada lado. */
const TOAST_ROOM = TOAST_GAP + 48 + TOAST_GAP;

/**
 * A cuántos px del borde de abajo va el aviso: 16 por encima del pie fijo más
 * alto. `rects` son los pies de la pantalla (la barra de pestañas, el pie de
 * Cobrar, el de una hoja). Cuenta el pie bajo el que el aviso no cabría: el
 * que llega al borde (o casi) y el que va encima de otro que cuenta. Un pie a
 * media pantalla (el de una ventana centrada) no: el aviso cabe debajo. Sin
 * ninguno, `null`: lo decide el CSS (16 px del borde; 24 con ratón).
 */
export function toastBottom(rects: ReadonlyArray<{ top: number; bottom: number }>, height: number): number | null {
  let edge = height;
  const visible = rects.filter((r) => r.bottom > r.top && r.top < height && r.bottom > 0);
  for (const r of [...visible].sort((a, b) => b.bottom - a.bottom)) {
    if (r.bottom > edge - TOAST_ROOM && r.top < edge) edge = r.top;
  }
  return edge === height ? null : height - edge + TOAST_GAP;
}
