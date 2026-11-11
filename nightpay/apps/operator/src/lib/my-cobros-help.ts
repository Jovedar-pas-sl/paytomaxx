// «Si pasa esto» de Cobros del personal: lo que se resuelve desde el personal,
// con el botón exacto, o a quién avisar. Lo usa la Guía rápida (/guia); el
// tutorial del «?» de Cobros (tours.ts) lo cuenta en sus pasos. Funciones puras.

/** Quién mira: la chica cancela en la lista sus cobros sin pagar (roles.ts: cancelPending). */
export interface MyCobrosViewer {
  cancelPending: boolean;
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
