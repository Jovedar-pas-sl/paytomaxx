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
