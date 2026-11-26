// El detalle de un cobro, al lado de la lista (lógica pura): qué fila enseña, a
// cuál se va con las flechas y cuándo una tecla o un toque no son para él.

import type { CobroRow } from '@nightpay/contracts';

/** Lo que guarda el detalle: qué cobro está abierto (la fila sale de la lista en cada pintada). */
export type DockKey = Pick<CobroRow, 'kind' | 'id'>;

/** Lo que hace falta de un elemento del DOM (así se prueba sin navegador). */
interface Closest {
  closest: (selectors: string) => unknown;
}

function indexOf(rows: readonly CobroRow[], key: DockKey): number {
  return rows.findIndex((r) => r.kind === key.kind && r.id === key.id);
}

/** La fila del cobro abierto, de la última respuesta del API; si ya no está en la lista, la última vista. */
export function dockRow(rows: readonly CobroRow[] | null, key: DockKey | null, last: CobroRow | null): CobroRow | null {
  if (!key) return null;
  const found = rows ? rows[indexOf(rows, key)] : undefined;
  if (found) return found;
  return last && last.kind === key.kind && last.id === key.id ? last : null;
}

/** Una fila del cobro abierto y la vuelta de datos de la que sale (sube tras devolver, anular o resolver). */
export interface DockSeen {
  row: CobroRow;
  version: number;
}

/**
 * Lo que enseña el detalle: la fila más nueva del cobro abierto (la de la
 * lista o, si ya no está, la última vista o la que se pidió aparte) y, para
 * los botones del pie, solo una fila al día. Tras devolver, anular o resolver,
 * una fila de antes miente (el estado, lo que queda por devolver): con el
 * filtro «Pagado», una devolución entera saca el cobro de la lista. Hasta que
 * llega una de después (`version`), sin botones de dinero.
 */
export function dockView(
  rows: readonly CobroRow[] | null,
  rowsVersion: number,
  key: DockKey | null,
  seen: ReadonlyArray<DockSeen | null>,
  version: number,
): { seen: DockSeen | null; actionsRow: CobroRow | null } {
  if (!key) return { seen: null, actionsRow: null };
  const found = rows ? rows[indexOf(rows, key)] : undefined;
  let best: DockSeen | null = found ? { row: found, version: rowsVersion } : null;
  for (const s of seen) {
    if (s && s.row.kind === key.kind && s.row.id === key.id && (!best || s.version > best.version)) best = s;
  }
  return { seen: best, actionsRow: best && best.version >= version ? best.row : null };
}

/** El cobro anterior (−1) o el siguiente (+1) de los cargados; en los bordes, nada. */
export function neighbour(rows: readonly CobroRow[] | null, key: DockKey | null, step: -1 | 1): CobroRow | null {
  if (!rows || !key) return null;
  const at = indexOf(rows, key);
  return at < 0 ? null : (rows[at + step] ?? null);
}

export type DockKeyAction = 'prev' | 'next' | 'close';

const KEYS: Readonly<Record<string, DockKeyAction>> = { ArrowUp: 'prev', ArrowDown: 'next', Escape: 'close' };

/**
 * Lo que pide una tecla pulsada en la lista o en el detalle. Desde un campo o
 * desde una ventana (devolver, «Verificar», un menú) no es para el detalle:
 * allí Esc cierra solo esa ventana y las flechas mueven el cursor.
 */
export function dockKeyAction(key: string, target: Closest | null): DockKeyAction | null {
  const action = KEYS[key];
  if (!action || !target) return null;
  return target.closest('input, select, textarea, [role="dialog"], [role="alertdialog"]') ? null : action;
}

/** Tocar la fila abre el detalle; un botón o un enlace de dentro (la ficha de la compañera, el saldo) hace lo suyo. */
export function clickOpensRow(target: Closest | null): boolean {
  return Boolean(target) && !target!.closest('button, a');
}
