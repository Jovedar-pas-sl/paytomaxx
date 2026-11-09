// «Cobros» del personal (Grafito 2): la línea de ayuda de arriba y lo de
// «¿Qué significa cada estado?»: cada estado que de verdad puede salir en la
// lista y qué hacer, y «Si pasa esto»: lo que se resuelve desde el personal,
// con el botón exacto, o a quién avisar. Funciones puras.

import { PaymentStatusSchema } from '@nightpay/contracts';
import { ownCobroState, type OwnCobroIcon, type OwnCobroTone } from './my-cobros';

/** La clave de la ayuda de esta pantalla (help-line.ts). */
export const MY_COBROS_HELP_SCREEN = 'cobros';

/**
 * Los estados que trae /staff/me/cobros: los del cobro con tarjeta o QR
 * (PaymentStatus) y los del cobro con el saldo, que solo sale aceptado o
 * anulado (cobros-rows.ts: saldoCobroRow).
 */
export const OWN_COBRO_STATUSES: readonly string[] = [...PaymentStatusSchema.options, 'ACCEPTED', 'REVERSED'];

/** Quién mira: la chica cancela en la lista sus cobros sin pagar (roles.ts: cancelPending). */
export interface MyCobrosViewer {
  cancelPending: boolean;
}

/** La línea de arriba: qué es la lista y qué se puede hacer con un cobro. */
export function myCobrosHelpLine(viewer: MyCobrosViewer): string {
  return viewer.cancelPending
    ? 'Tus cobros, del último al primero. Si uno sigue pendiente y el cliente ya no paga, toca «Cancelar».'
    : 'Tus cobros, del último al primero. Para devolver uno, avisa al encargado o al dueño.';
}

export interface StateHelp {
  label: string;
  tone: OwnCobroTone;
  icon: OwnCobroIcon;
  /** Qué quiere decir y qué hacer. */
  text: string;
}

/** Un estado de cada, por el orden en que se explican (el más corriente, primero). */
const ORDER = ['AUTHORIZED', 'CREATED', 'AUTHORIZING', 'ORPHAN', 'FAILED', 'EXPIRED', 'CANCELED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'] as const;

function stateText(status: (typeof ORDER)[number], viewer: MyCobrosViewer): string {
  switch (status) {
    case 'AUTHORIZED':
      return 'El cliente ha pagado y cuenta en tu noche. No hay nada que hacer.';
    case 'CREATED':
      return viewer.cancelPending
        ? 'Aún no ha pagado: su QR o el datáfono siguen esperando. Si ya no va a pagar, toca «Cancelar» en ese cobro.'
        : 'Aún no ha pagado: su QR o el datáfono siguen esperando. Si no paga, caduca solo.';
    case 'AUTHORIZING':
      return 'Está pagando en la página de su banco. Espera la respuesta y no cobres otra vez.';
    case 'ORPHAN':
      return 'El banco no contestó a tiempo y puede que sí se cobrara. No cobres otra vez; si sigue así, avisa al encargado.';
    case 'FAILED':
      return 'El banco no lo aceptó: no se ha cobrado. Si aún quiere pagar, haz un cobro nuevo.';
    case 'EXPIRED':
      return 'Se acabó el tiempo del QR sin pagar: no se ha cobrado. Si aún quiere pagar, haz un cobro nuevo.';
    case 'CANCELED':
      return 'Se canceló antes de pagar: no se ha cobrado nada.';
    case 'PARTIALLY_REFUNDED':
      return 'Se le devolvió una parte. La fila dice cuánto queda cobrado.';
    case 'REFUNDED':
      return 'Se le devolvió todo: ya no cuenta en tu noche.';
    case 'REVERSED':
      return 'Era un cobro con su saldo y se anuló: el dinero volvió a su saldo.';
  }
}

/** «¿Qué significa cada estado?»: los que pueden salir, sin repetir (Cobrado, Pendiente…). */
export function myCobrosStates(viewer: MyCobrosViewer): StateHelp[] {
  return ORDER.map((status) => ({ ...ownCobroState(status), text: stateText(status, viewer) }));
}

export interface Situation {
  /** «El banco tarda». */
  when: string;
  /** Qué hacer: el botón exacto o a quién avisar. */
  todo: string;
}

/** «Si pasa esto»: solo lo que se resuelve desde el personal (con su botón) o a quién avisar. */
export function myCobrosSituations(viewer: MyCobrosViewer): Situation[] {
  return [
    {
      when: 'El banco tarda',
      todo: 'Quédate en la pantalla del cobro y no cobres otra vez: si se cobra, lo verás ahí. Si sale «Sin confirmar», toca «Avisar al encargado».',
    },
    {
      when: 'El cliente se va sin pagar',
      todo: viewer.cancelPending
        ? 'Toca «Cancelar» en su cobro pendiente de esta lista.'
        : 'Si su cobro sigue en pantalla, toca «Cancelar cobro». Si ya no, no hagas nada: caduca solo.',
    },
    {
      when: 'Dice que ha pagado dos veces',
      todo: 'Busca sus cobros aquí. Si pone que la tarjeta se devolvió sola, ya está. Si pone «hay que devolver» o ves dos cobros iguales, avisa al encargado.',
    },
    {
      when: 'Quiere que le devuelvan un cobro',
      todo: 'Desde aquí no se puede: avisa al encargado o al dueño, que lo devuelven desde el panel.',
    },
    {
      when: 'Quiere lo que le queda en el saldo',
      todo: 'Que vaya a recepción: allí, en «Salida», se lo devuelven en efectivo.',
    },
  ];
}
