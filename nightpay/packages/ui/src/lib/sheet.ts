// La hoja (Sheet): lo puro. Cuándo un arrastre pide cerrarla, dónde va el
// menú en una pantalla ancha y la entrada de cada hoja abierta en el historial
// del navegador («atrás» cierra la de encima). `window`, solo al llamarlas
// (desde un efecto o un toque): se importa sin navegador.

/** Un tirón: al menos estos px… */
const FLICK_PX = 24;
/** …a esta velocidad o más (px por ms). */
const FLICK_SPEED = 0.5;

/**
 * ¿El arrastre pide cerrar? Si baja más de un cuarto del alto de la hoja, o
 * si es un tirón (24 px o más, a 0,5 px/ms o más). Hacia arriba, nunca.
 */
export function sheetDragEnd(dy: number, ms: number, height: number): boolean {
  if (dy <= 0) return false;
  return dy > height / 4 || (dy >= FLICK_PX && dy >= FLICK_SPEED * ms);
}

/** El hueco entre el botón y su menú, y lo mínimo hasta el borde de la pantalla. */
const MENU_GAP = 8;

interface Edges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
interface Size {
  width: number;
  height: number;
}

/**
 * Dónde va el menú (esquina de arriba a la izquierda): debajo de su botón si
 * cabe y, si no, encima; alineado con él por la izquierda y nunca a menos de
 * 8 px del borde de la pantalla.
 */
export function menuPosition(anchor: Edges, panel: Size, screen: Size): { top: number; left: number } {
  const below = anchor.bottom + MENU_GAP;
  const fits = below + panel.height <= screen.height - MENU_GAP;
  const top = fits ? below : anchor.top - MENU_GAP - panel.height;
  const left = Math.min(anchor.left, screen.width - MENU_GAP - panel.width);
  return { top: Math.max(MENU_GAP, top), left: Math.max(MENU_GAP, left) };
}

// ─── «Atrás» cierra la hoja ────────────────────────────────────────────────
// Al abrirse, cada hoja deja una entrada en el historial (la misma página, con
// su marca en history.state). «Atrás» quita esa entrada y la hoja de encima
// recibe su onClose; si se cierra de otra forma (la ✕, Esc, se desmonta), la
// entrada se quita con history.back().

interface OpenSheet {
  id: string;
  close: () => void;
  /** Su entrada está en el historial. */
  entry: boolean;
}

/** Las hojas abiertas, de abajo arriba. */
let sheets: OpenSheet[] = [];
/** Los back() nuestros que aún no han llegado como popstate: esos «atrás» no cierran nada. */
let ownBacks = 0;
let listening = false;

/** La hoja de una entrada del historial (null: no es de ninguna). */
function entryOf(state: unknown): string | null {
  const id = (state as { npSheet?: unknown } | null)?.npSheet;
  return typeof id === 'string' ? id : null;
}

function write(how: 'pushState' | 'replaceState', sheet: OpenSheet): void {
  // Nunca null ni un estado nuevo: se conserva lo que ya hubiera (Next guarda ahí su árbol y recarga si no lo encuentra).
  window.history[how]({ ...(window.history.state as Record<string, unknown> | null), npSheet: sheet.id }, '');
  sheet.entry = true;
}

/** Deja el historial como las hojas abiertas: cada una con su entrada, y ninguna entrada de una hoja ya cerrada arriba. */
function settle(): void {
  // Con un back() nuestro en camino, se mira cuando llegue.
  if (ownBacks > 0) return;
  const current = entryOf(window.history.state);
  if (current !== null && !sheets.some((s) => s.id === current)) {
    const heir = sheets.find((s) => !s.entry);
    if (heir) {
      // La hoja de esa entrada se cerró a la vez que se abría otra (el menú que abre «Mi perfil»): la hereda.
      write('replaceState', heir);
    } else {
      if (window.history.length > 1) {
        ownBacks += 1;
        window.history.back();
      }
      return;
    }
  }
  for (const sheet of sheets) {
    if (sheet.id === entryOf(window.history.state)) sheet.entry = true;
    else if (!sheet.entry) write('pushState', sheet);
  }
}

function onPopState(): void {
  if (ownBacks > 0) {
    ownBacks -= 1;
  } else {
    // «Atrás» del usuario: las hojas por encima de la entrada a la que se ha vuelto se quedan sin la suya.
    const at = sheets.findIndex((s) => s.id === entryOf(window.history.state));
    const lost = sheets.slice(at + 1).filter((s) => s.entry);
    if (lost.length > 0) {
      for (const sheet of lost) sheet.entry = false;
      // Solo la de encima; y decide quien la usa (mientras guarda no se cierra).
      sheets[sheets.length - 1]!.close();
      // Si sigue abierta, su entrada vuelve: el siguiente «atrás» tampoco sale de la página.
      window.setTimeout(settle, 0);
      return;
    }
  }
  settle();
}

/**
 * Una hoja se abre: queda apuntada y con su entrada en el historial. Devuelve
 * lo que hay que llamar cuando se cierra o se desmonta.
 */
export function openSheetEntry(id: string, close: () => void): () => void {
  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  const sheet: OpenSheet = { id, close, entry: false };
  sheets = [...sheets, sheet];
  settle();
  return () => {
    sheets = sheets.filter((s) => s !== sheet);
    // Tras los efectos de este render: una hoja que se abre a la vez hereda la entrada y no hace falta volver atrás.
    void Promise.resolve().then(settle);
  };
}

/** Para las pruebas: olvida las hojas abiertas y los back() pendientes. */
export function resetSheetHistory(): void {
  sheets = [];
  ownBacks = 0;
}
