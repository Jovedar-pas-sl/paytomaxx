// Recepción, cargar la ficha (Grafito 2): lo que hay que hacer en cada paso,
// corto y en español llano, para el personal a oscuras y con prisa. Lo usan el
// tutorial del «?» (tours.ts), la Guía rápida (/guia) y los textos que quedan
// a la vista en el paso (lo que se mete en la caja, la ficha que se entrega).
// Funciones puras: se prueban sin pantalla.

import type { ReceptionDeskView } from '@nightpay/contracts';
import { formatEur } from './money';
import type { PinAfterLoad } from './reception-desk';

/** «Acerca el NFC»: qué hacer con la ficha (entrada o salida). */
export function tapHelp(mode: 'entrada' | 'salida'): string {
  return mode === 'entrada'
    ? 'Pon la ficha del cliente detrás del móvil: la app sabe si es nueva o si ya tiene saldo.'
    : 'Pon su ficha detrás del móvil para ver lo que le queda.';
}

/** «¿Cuánto carga?». */
export const AMOUNT_HELP = 'Toca lo que quiere cargar. Si no está, «Otro» y lo tecleas.';

/**
 * «¿Cómo paga?» (A2): primero el dinero y después el botón; el de efectivo
 * carga en cuanto se toca, así que no se toca antes de tenerlo.
 */
export const METHOD_HELP = 'Cobra primero y toca cómo te ha pagado.';

/**
 * Debajo de «Efectivo» (A2): «Ya tengo los 56 € en la mano» (lo que paga el
 * cliente, con la comisión del servicio si la hay). Antes decía «Lo metes en
 * la caja», una orden para después: se tocaba sin tener el dinero.
 */
export function cashInHandText(chargeCents: number): string {
  return `Ya tengo los ${formatEur(chargeCents, { compact: true })} en la mano`;
}

/**
 * B2: tras tocar «Efectivo», se carga al acercar otra vez la misma ficha:
 * «Al acercarla se cargan 50 € en su saldo. Con otra ficha no se carga.»
 */
export function cashConfirmText(amountCents: number): string {
  return `Al acercarla se cargan ${formatEur(amountCents, { compact: true })} en su saldo. Con otra ficha no se carga.`;
}

/**
 * «¿Cómo paga?» se enseña al cliente (A5): lo que va a pagar y su ficha, en
 * grande, antes de cobrar.
 */
export function turnPhoneText(hasFicha: boolean): string {
  return hasFicha ? 'Gira el móvil: que vea el importe y su ficha' : 'Gira el móvil: que vea el importe';
}

/** Qué se hace con la ficha en CARGADO (lo mismo que dice handOverLine, como orden). */
export type HandOver = 'give' | 'return' | 'code' | 'manager' | 'none';

/**
 * Como handOverLine: una ficha nueva que se dio, se le da; la suya (leída o
 * buscada por número), se le devuelve; sin ficha, que apunte su código; un
 * saldo sin ficha (por su código), nada. Sin ficha y sin código en pantalla
 * (no se pudo leer su saldo nuevo: `hasCode` false), no hay nada que apuntar:
 * al encargado, como dice el aviso de debajo.
 */
export function handOverOf(o: { view: ReceptionDeskView | null; linked: boolean; byNumber: boolean; hasCode: boolean }): HandOver {
  if (o.byNumber) return 'return';
  if (o.view?.kind === 'saldo') return o.view.fichaNumber === null ? 'none' : 'return';
  if (o.view && o.linked) return 'give';
  return o.hasCode ? 'code' : 'manager';
}

const HAND_OVER_TEXT: Record<HandOver, string | null> = {
  give: 'dale la ficha',
  return: 'devuélvele su ficha',
  code: 'que apunte su código',
  manager: 'avisa al encargado',
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
