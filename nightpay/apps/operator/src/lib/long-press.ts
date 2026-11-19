// Mantener pulsada una loseta (sin DOM, para probarlo): pasado LONG_PRESS_MS sin
// soltar ni mover el dedo se dispara `onLong`, y el «click» que viene al soltar
// se descarta (si no, el mismo gesto añadiría el producto a la cuenta).

export const LONG_PRESS_MS = 600;
/** Mover el dedo más de esto es hacer scroll, no mantener. */
const MOVE_PX = 10;

export interface LongPress {
  down: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  /** Soltar o salir de la loseta: cancela la espera. */
  cancel: () => void;
  /** Al llegar el click: false si ya fue una pulsación larga (no es un toque). */
  click: () => boolean;
}

export function createLongPress(onLong: () => void, ms = LONG_PRESS_MS): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let origin = { x: 0, y: 0 };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    down(x, y) {
      cancel();
      fired = false;
      origin = { x, y };
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        onLong();
      }, ms);
    },
    move(x, y) {
      if (timer && Math.hypot(x - origin.x, y - origin.y) > MOVE_PX) cancel();
    },
    cancel,
    click() {
      const wasLong = fired;
      fired = false;
      return !wasLong;
    },
  };
}
