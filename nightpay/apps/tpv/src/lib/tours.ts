// Los tutoriales del TPV: el «?» de la cabecera abre el de la pantalla que se
// ve (cobro o espera) y, la primera vez que se abre cada una en este aparato,
// sale solo si la pantalla está libre. Cada paso apunta a un elemento con
// `data-tour="…"`; el que no está en pantalla se salta.

import type { TourStep } from '@nightpay/ui';

export interface TourDef {
  /** Una clave de localStorage por pantalla: np-tour-<screen>-v1. */
  screen: string;
  steps: readonly TourStep[];
}

export const TOURS = {
  cobro: {
    screen: 'tpv-cobro',
    steps: [
      { target: 'tpv-terminal', title: 'Terminal', text: 'Elige la caja que cobra. Si solo hay una, ya está puesta.' },
      { target: 'tpv-teclado', title: 'El importe', text: 'Teclea lo que cobras: las cifras entran por los céntimos. Con teclado físico también vale.' },
      { target: 'tpv-cobrar', title: 'Cobrar', text: 'Cuando esté el importe, toca «Cobrar»: sale el QR para que el cliente pague con su móvil.' },
    ],
  },
  espera: {
    screen: 'tpv-espera',
    steps: [
      { target: 'tpv-qr', title: 'El QR', text: 'El cliente lo escanea con la cámara de su móvil. Si no puede, «Copiar» le pasa el enlace.' },
      { target: 'tpv-importe', title: 'Lo que paga', text: 'El importe del cobro. Si el local cobra comisión del servicio, aquí ves lo que paga con tarjeta.' },
      { target: 'tpv-estado', title: 'Cómo va', text: 'Cuando el cliente pague, sale Pagado. Si el banco tarda, espera: no cobres otra vez.' },
      { target: 'tpv-cancelar', title: 'Cancelar cobro', text: 'Si el cliente ya no va a pagar, cancela el cobro. Después puedes hacer uno nuevo.' },
    ],
  },
} as const satisfies Record<string, TourDef>;
