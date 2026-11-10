// Recepción, cargar la ficha (Grafito 2): la línea de ayuda de cada paso,
// corta y en español llano, para el personal a oscuras y con prisa. Se cierra
// con «Entendido» (help-line.ts). Funciones puras: se prueban sin pantalla.

import type { ReceptionDeskView } from '@nightpay/contracts';
import type { PinAfterLoad } from './reception-desk';

/** Las claves de cada pantalla (una por paso: cerrar una no cierra las otras). */
export const RECEPTION_HELP_SCREENS = {
  nfc: 'recepcion-nfc',
  amount: 'recepcion-importe',
  method: 'recepcion-pago',
  loaded: 'recepcion-cargado',
} as const;

/** «Acerca el NFC»: qué hacer con la ficha (entrada o salida). */
export function tapHelp(mode: 'entrada' | 'salida'): string {
  return mode === 'entrada'
    ? 'Pon la ficha del cliente detrás del móvil: la app sabe si es nueva o si ya tiene saldo.'
    : 'Pon su ficha detrás del móvil para ver lo que le queda.';
}

/** «¿Cuánto carga?». */
export const AMOUNT_HELP = 'Toca lo que quiere cargar. Si no está, «Otro» y lo tecleas.';

/** «¿Cómo paga?» (cada botón ya dice qué pasa con el dinero: aquí, solo qué hacer). */
export const METHOD_HELP = 'Toca cómo te paga: la ficha se carga en cuanto está cobrado.';

/** Qué se hace con la ficha en CARGADO (lo mismo que dice handOverLine, como orden). */
export type HandOver = 'give' | 'return' | 'code' | 'none';

/**
 * Como handOverLine: una ficha nueva que se dio, se le da; la suya (leída o
 * buscada por número), se le devuelve; sin NFC, que apunte su código; un
 * saldo sin ficha (por su código), nada.
 */
export function handOverOf(o: { view: ReceptionDeskView | null; linked: boolean; byNumber: boolean }): HandOver {
  if (o.byNumber) return 'return';
  if (o.view?.kind === 'saldo') return o.view.fichaNumber === null ? 'none' : 'return';
  if (o.view && o.linked) return 'give';
  return 'code';
}

const HAND_OVER_TEXT: Record<HandOver, string | null> = {
  give: 'dale la ficha',
  return: 'devuélvele su ficha',
  code: 'que apunte su código',
  none: null,
};

/** «a, b y c». */
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * CARGADO: qué hacer ahora, en orden. El efectivo a la caja, la ficha al
 * cliente y, si pasa del tope sin PIN, que elija su PIN. Si el PIN lo pone el
 * encargado (`manager`), ya lo dice el aviso de debajo: aquí no se repite.
 */
export function loadedHelp(o: { method: 'cash' | 'card'; handOver: HandOver; pin: PinAfterLoad }): string {
  const parts = [
    o.method === 'cash' ? 'mete el efectivo en la caja' : null,
    HAND_OVER_TEXT[o.handOver],
    o.pin === 'ask' ? 'pásale el móvil para que elija su PIN' : null,
  ].filter((p): p is string => p !== null);
  const offer = o.pin === 'offer' ? 'Si quiere, que elija su PIN.' : null;
  if (parts.length === 0) return offer ?? 'Ya está cargado: no hay que hacer nada más.';
  return [`${capital(list(parts))}.`, offer].filter(Boolean).join(' ');
}
