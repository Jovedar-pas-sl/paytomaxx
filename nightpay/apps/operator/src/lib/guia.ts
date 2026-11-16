// La «Guía rápida» del personal (/guia, desde el menú del logo): cómo cobrar,
// cómo cargar una ficha en recepción y qué hacer si algo sale distinto. Cada
// paso, con su captura de la demo (datos inventados, WebP en public/guia) y
// una frase corta. Las frases de recepción y lo de «Qué hago si…» son las
// ayudas que ya salen en la app (reception-help.ts, my-cobros-help.ts,
// cobro-view.ts): se importan, no se copian, y si cambian allí cambian aquí.

import { NO_PIN_SENTENCE, NO_PIN_TITLE } from './cobro-view';
import { myCobrosSituations, type Situation } from './my-cobros-help';
import { AMOUNT_HELP, METHOD_HELP, loadedHelp, tapHelp } from './reception-help';

/** La ruta de la guía (la entrada del menú del logo lleva aquí). */
export const GUIA_PATH = '/guia';

/** Donde están las capturas (apps/operator/public/guia). */
export const GUIA_IMAGE_DIR = '/guia/';

export interface GuiaStep {
  /** La captura, en public/guia (WebP). */
  image: string;
  /** Su tamaño en píxeles (el ancho y el alto de la imagen, para que no salte al cargar). */
  width: number;
  height: number;
  /** Qué se ve, para el lector de pantalla. */
  alt: string;
  /** Qué hacer, en una frase. */
  text: string;
}

export interface GuiaSection {
  /** El ancla (/guia#cobrar). */
  id: string;
  title: string;
  /** Dónde se hace, si hace falta decirlo. */
  lead: string | null;
  steps: readonly GuiaStep[];
}

const img = (name: string, width: number, height: number) => ({ image: `${GUIA_IMAGE_DIR}${name}.webp`, width, height });

/** Cobrar: carta → cuenta → «Cobrar» → el cliente paga con QR o con su ficha → «Pagado». */
export const GUIA_COBRAR: GuiaSection = {
  id: 'cobrar',
  title: 'Cómo cobrar',
  lead: 'En Inicio, la carta de tu sección.',
  steps: [
    {
      ...img('cobrar-1-carta', 480, 600),
      alt: 'La carta en Inicio: losetas de colores con cada producto y su precio.',
      text: 'Toca lo que pide el cliente: cada toque suma uno. Si te equivocas, «Deshacer».',
    },
    {
      ...img('cobrar-2-cuenta', 480, 547),
      alt: 'Debajo de la carta, lo que llevas y el botón «Cobrar 33 €».',
      text: 'Abajo ves lo que llevas. «Ver cuenta» para revisarlo y «Cobrar» cuando esté todo.',
    },
    {
      ...img('cobrar-3-qr', 480, 787),
      alt: 'El cobro abierto: el importe, «Acerca la ficha o escanea» y el QR.',
      text: 'El cliente escanea el QR con su móvil o acerca su ficha por detrás del tuyo.',
    },
    {
      ...img('cobrar-4-cliente', 480, 843),
      alt: 'La página de pago en el móvil del cliente: el importe, la propina y el botón de pagar.',
      text: 'En su móvil elige la propina y paga con Apple Pay, Google Pay o tarjeta.',
    },
    {
      ...img('cobrar-5-pagado', 480, 693),
      alt: 'La pantalla verde de «Pagado» con el importe y el código de confirmación.',
      text: '«Pagado», con un código que el cliente también ve en su móvil. Luego, «Nuevo cobro».',
    },
  ],
};

/** Cargar una ficha en recepción: las mismas líneas de ayuda que salen en cada paso. */
export const GUIA_CARGAR: GuiaSection = {
  id: 'cargar',
  title: 'Cómo cargar una ficha',
  lead: 'En la pestaña «Recepción», con «Entrada» marcado.',
  steps: [
    {
      ...img('cargar-1-nfc', 480, 587),
      alt: 'Recepción en «Entrada»: «Acerca la ficha».',
      text: tapHelp('entrada'),
    },
    {
      ...img('cargar-2-importe', 480, 549),
      alt: '«¿Cuánto carga?» con los importes 20 €, 50 €, 100 € y «Otro».',
      text: AMOUNT_HELP,
    },
    {
      ...img('cargar-3-pago', 480, 635),
      alt: '«¿Cómo paga?» con «Efectivo» y «Tarjeta».',
      text: METHOD_HELP,
    },
    {
      ...img('cargar-4-cargado', 480, 899),
      alt: 'La pantalla verde de «CARGADO» con el importe, el efectivo a la caja y los botones del PIN.',
      text: loadedHelp({ method: 'cash', handOver: 'give', pin: 'ask' }),
    },
  ],
};

/** Las dos secciones con pasos, en orden. */
export const GUIA_SECTIONS: readonly GuiaSection[] = [GUIA_COBRAR, GUIA_CARGAR];

/**
 * En «Cobros», «aquí» es esa lista o la app; en la guía no se sabe dónde es:
 * se dice el sitio. Solo eso cambia del texto de la app.
 */
const OUT_OF_COBROS: ReadonlyArray<readonly [string, string]> = [
  ['Busca sus cobros aquí', 'Busca sus cobros en «Cobros»'],
  ['Desde aquí no se puede', 'Desde la app no se puede'],
];

/** Un texto de «Cobros», dicho fuera de «Cobros». */
export function outOfCobros(text: string): string {
  return OUT_OF_COBROS.reduce((t, [here, there]) => t.replace(here, there), text);
}

/**
 * «Qué hago si…»: los de «Cobros» (lo que vale para todo el personal) y el de
 * la ficha sin PIN del cobro. Los mismos textos que en la app.
 */
export function guiaSituations(): Situation[] {
  const cobros = myCobrosSituations({ cancelPending: false }).map((c) => ({ when: c.when, todo: outOfCobros(c.todo) }));
  return [...cobros, { when: NO_PIN_TITLE, todo: NO_PIN_SENTENCE }];
}

/** Todas las capturas de la guía. */
export function guiaImages(): string[] {
  return GUIA_SECTIONS.flatMap((s) => s.steps.map((step) => step.image));
}
