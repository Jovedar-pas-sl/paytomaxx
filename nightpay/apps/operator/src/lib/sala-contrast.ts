// Modo «sala» (Ajustes → Noche → «Modo sala», decisión D9): la app del
// personal en contraste alto. Lo pone el dueño para todo el local; aquí solo
// se aplica: un atributo en <html> (las fichas de @nightpay/ui/styles.css
// cambian con él) y una copia en este móvil para que, al abrir la app, salga
// ya así (el layout la lee antes de pintar) en vez de cambiar al llegar los
// ajustes.

/** El atributo de <html> que activa las fichas de contraste alto. */
export const SALA_ATTR = 'data-contrast';
export const SALA_VALUE = 'sala';
/** La copia en este móvil (la lee el script del layout antes de pintar). */
export const SALA_STORAGE_KEY = 'np-contrast';

interface RootLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface StorageLike {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Enciende o apaga el modo sala en <html> y lo recuerda en este móvil (sin guardar si no se puede). */
export function applySalaContrast(root: RootLike, storage: StorageLike | null, on: boolean): void {
  if (on) root.setAttribute(SALA_ATTR, SALA_VALUE);
  else root.removeAttribute(SALA_ATTR);
  try {
    if (on) storage?.setItem(SALA_STORAGE_KEY, SALA_VALUE);
    else storage?.removeItem(SALA_STORAGE_KEY);
  } catch {
    // Navegación privada o almacenamiento lleno: se aplica igual, solo no se recuerda.
  }
}

/**
 * El trozo del script del layout (antes de pintar): si este móvil recuerda el
 * modo sala, lo pone ya. Sin barras invertidas: va dentro de una plantilla.
 */
export const SALA_INIT_SCRIPT = `try{if(localStorage.getItem('${SALA_STORAGE_KEY}')==='${SALA_VALUE}')document.documentElement.setAttribute('${SALA_ATTR}','${SALA_VALUE}');}catch(e){}`;
