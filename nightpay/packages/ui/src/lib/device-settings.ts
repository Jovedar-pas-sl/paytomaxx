// Los ajustes de ESTE móvil (o navegador), guardados en localStorage: tema,
// vibrar al tocar y letra más grande. Nada va al servidor. Todo tolera un
// almacenamiento bloqueado (modo privado, datos borrados): entonces valen los
// de partida.

/** El tema ya existente (ThemeToggle y el script de arranque del panel): ahora también «system». */
export const THEME_KEY = 'np-theme';
export const HAPTIC_KEY = 'np-haptic';
export const BIGFONT_KEY = 'np-bigfont';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage si se puede usar; null si no. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(store: Pick<KeyValueStore, 'getItem'> | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Lo elegido; sin ajuste (o ilegible), el de partida de la app (el personal: oscuro; el panel: como el móvil). */
export function readThemeChoice(store: Pick<KeyValueStore, 'getItem'> | null, fallback: ThemeChoice): ThemeChoice {
  const v = read(store, THEME_KEY);
  return v === 'dark' || v === 'light' || v === 'system' ? v : fallback;
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

export function writeThemeChoice(store: Pick<KeyValueStore, 'setItem'> | null, choice: ThemeChoice): void {
  try {
    store?.setItem(THEME_KEY, choice);
  } catch {
    /* sin almacenamiento: vale para esta visita */
  }
}

/** Pone el tema en la página (data-theme) y lo guarda. */
export function applyThemeChoice(choice: ThemeChoice): ResolvedTheme {
  const dark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true;
  const theme = resolveTheme(choice, dark);
  document.documentElement.setAttribute('data-theme', theme);
  writeThemeChoice(browserStore(), choice);
  return theme;
}

/** Vibrar al tocar: sí salvo que se haya apagado. */
export function hapticEnabled(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): boolean {
  return read(store, HAPTIC_KEY) !== 'off';
}

export function writeHaptic(store: Pick<KeyValueStore, 'setItem' | 'removeItem'> | null, on: boolean): void {
  try {
    if (!store) return;
    if (on) store.removeItem(HAPTIC_KEY);
    else store.setItem(HAPTIC_KEY, 'off');
  } catch {
    /* sin almacenamiento: vale para esta visita */
  }
}

/** Letra más grande: no salvo que se haya encendido. */
export function readBigFont(store: Pick<KeyValueStore, 'getItem'> | null = browserStore()): boolean {
  return read(store, BIGFONT_KEY) === '1';
}

export function writeBigFont(store: Pick<KeyValueStore, 'setItem' | 'removeItem'> | null, on: boolean): void {
  try {
    if (!store) return;
    if (on) store.setItem(BIGFONT_KEY, '1');
    else store.removeItem(BIGFONT_KEY);
  } catch {
    /* sin almacenamiento: vale para esta visita */
  }
}

/** Pone la letra grande en la página (data-bigfont, que sube un paso las --np-fs-*) y la guarda. */
export function applyBigFont(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-bigfont', '1');
  else document.documentElement.removeAttribute('data-bigfont');
  writeBigFont(browserStore(), on);
}

/**
 * Para el <head>, antes de pintar (sin parpadeo): el tema según np-theme
 * (`fallback` si no hay ajuste) y la letra grande. Un solo script para las apps.
 */
export function deviceInitScript(fallback: ThemeChoice): string {
  return (
    "(function(){var d=document.documentElement;try{" +
    "var s=localStorage.getItem('" + THEME_KEY + "');" +
    "if(s!=='light'&&s!=='dark'&&s!=='system')s='" + fallback + "';" +
    "var t=s;if(s==='system')t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';" +
    "d.setAttribute('data-theme',t);" +
    "if(localStorage.getItem('" + BIGFONT_KEY + "')==='1')d.setAttribute('data-bigfont','1');" +
    "}catch(e){d.setAttribute('data-theme','" + (fallback === 'light' ? 'light' : 'dark') + "');}})();"
  );
}
