import type { StaffApp } from '@/lib/customer-pages';

/**
 * Textos de la portada. Regla: solo lo que OxioPay hace hoy (comprobado en el
 * código de main). Sin cifras, reseñas ni promesas. Una palabra por cosa:
 * ficha, saldo, cargar, cobro, Pagado, personal.
 *
 * Comprobado el 17-nov con main:
 *  - El saldo (decisión del dueño del 17-nov): lo que sobra se queda en el
 *    saldo para la próxima visita y no se devuelve en dinero (ni en efectivo
 *    ni a la tarjeta). Lo que sí se devuelve es un cobro con error. La captura
 *    del saldo (saldo.webp) va sin la fila «Me voy: devolver mi saldo».
 *  - Bitcoin (en marcha desde #47): solo para cargar saldo y para pagar un
 *    reservado (la señal y el resto), nunca en la barra. Cada local elige si
 *    lo acepta. Con Lightning llega al momento; en la red, con 1 confirmación.
 *  - Ya funcionan los reservados con señal, el enlace de cada RRPP con su
 *    comisión y la pantalla del cliente.
 *  - «Avisarme de cada cobro» no sale aquí: necesita las claves VAPID del
 *    servidor y producción aún no las tiene.
 */

/** [texto en negrita, resto de la frase]. */
export type Point = readonly [string, string];

export const PHONE_DISPLAY = '644 771 786';
export const PHONE_INTL = '(+34) 644 771 786';
export const PHONE_HREF = 'tel:+34644771786';

/** Las capturas reales de la app (public/portada, WebP a 2x de lo que se ve). */
export const SHOTS = {
  pago: { src: '/portada/pago.webp', width: 560, height: 1212, alt: 'Página de pago: 35,00 €, propina y botón Pagar' },
  pagado: { src: '/portada/pagado.webp', width: 560, height: 1212, alt: 'Pantalla de Pagado con el código de confirmación' },
  saldo: { src: '/portada/saldo.webp', width: 560, height: 1212, alt: 'Tu saldo: 50 €, con el número de ficha y los botones Pagar y Cargar' },
  cargarBitcoin: { src: '/portada/cargar-bitcoin.webp', width: 560, height: 1212, alt: 'Carga de saldo de 50 €: con tarjeta o con bitcoin' },
  bitcoinQr: { src: '/portada/bitcoin-qr.webp', width: 560, height: 1212, alt: 'Código QR para pagar la carga con bitcoin' },
  reservado: { src: '/portada/reservado.webp', width: 440, height: 952, alt: 'Reserva de un reservado con señal' },
} as const;

export type Shot = (typeof SHOTS)[keyof typeof SHOTS];

/** Menú de la cabecera y del pie: [ancla, texto]. */
export const MENU = [
  ['#como-funciona', 'Cómo funciona'],
  ['#clientes', 'Clientes'],
  ['#locales', 'Locales'],
  ['#bitcoin', 'Bitcoin'],
  ['#preguntas', 'Preguntas'],
  ['#contacto', 'Contacto'],
] as const;

export const STEPS = [
  {
    title: 'Escanea el QR',
    text: 'El personal te lo enseña en su móvil o en la caja. No hace falta instalar nada ni registrarse.',
  },
  {
    title: 'Elige cómo pagar',
    text: 'Tarjeta, Apple Pay, Google Pay o tu saldo. Ves el total antes de pagar y la propina la decides tú.',
  },
  {
    title: 'Pagado',
    text: 'En cuanto el banco lo confirma, lo ves en pantalla y puedes guardar el justificante.',
  },
] as const;

export const FOR_CLIENTS: readonly Point[] = [
  ['Sin app ni registro:', 'solo tu móvil.'],
  ['Pago seguro:', 'la tarjeta la escribes en la página segura del banco, no en OxioPay.'],
  ['Tu saldo:', 'prepago. Pagas con tu PIN o con Face ID o huella; con la ficha, los importes pequeños pueden ir sin PIN si el local lo permite.'],
  ['Lo que te sobra:', 'se queda en tu saldo para tu próxima visita. No se devuelve en dinero.'],
];

export type VenueIcon = 'qr' | 'screen' | 'bitcoin' | 'heart' | 'calendar' | 'people' | 'chart' | 'percent' | 'bell';

export const FOR_VENUES: readonly (readonly [VenueIcon, string, string])[] = [
  ['qr', 'Cobra como quieras', 'Con QR, con datáfono o con el saldo del cliente.'],
  ['screen', 'Pantalla del cliente', 'Una tablet enseña al cliente el importe y el QR para pagar.'],
  ['bitcoin', 'Bitcoin, si quieres', 'Tus clientes cargan su saldo y pagan su reservado con bitcoin, y tú lo recibes en tu propio BTCPay.'],
  ['heart', 'Fideliza', 'El saldo de tus clientes les espera para la próxima visita y puede valer en todos tus locales.'],
  ['calendar', 'Reservados', 'Tus clientes reservan desde el móvil y pagan la señal o todo. Cada persona del grupo tiene su QR.'],
  ['people', 'RRPP', 'Cada RRPP tiene su enlace para reservar y su comisión se calcula sola.'],
  ['chart', 'Lo cobrado, cada noche', 'Un panel con lo cobrado cada noche.'],
  ['percent', 'Comisiones del personal', 'Se calculan solas.'],
  ['bell', 'Avisos en Telegram', 'Lo que tienes que aprobar o revisar te llega en minutos y, cada mañana, el resumen de la noche.'],
];

export const BITCOIN_POINTS: readonly Point[] = [
  ['Para cargar saldo:', 'cargas tu saldo con bitcoin y después pagas con él.'],
  ['En la barra, no:', 'allí pagas con el saldo que cargaste.'],
  ['El local decide:', 'cada local elige si acepta bitcoin.'],
  ['Lightning o en la red:', 'con Lightning, si el local lo tiene, llega al momento; en la red, con 1 confirmación.'],
];

/** Efectivo y datáfono frente a OxioPay: solo hechos. */
export const VERSUS: readonly (readonly { topic: string; before: Point; after: Point }[])[] = [
  [
    {
      topic: 'El justificante',
      before: ['En papel:', 'el ticket de la caja o del datáfono.'],
      after: ['En tu móvil:', 'ves «Pagado» en pantalla y puedes guardar el justificante.'],
    },
    {
      topic: 'Si se pierde',
      before: ['Efectivo:', 'el que se pierde no se recupera.'],
      after: [
        'Ficha bloqueada:',
        'si pierdes la ficha, avisa en el local y la bloquean: lo que te queda de saldo no se pierde y en recepción te dan otra (el local puede cobrarla).',
      ],
    },
  ],
  [
    {
      topic: 'Al cerrar la noche',
      before: ['Por separado:', 'el efectivo por un lado y cada datáfono con su propio cierre.'],
      after: ['Un solo cierre:', 'lo cobrado cada noche en un panel, con el arqueo de caja.'],
    },
    {
      topic: 'Comisiones del personal',
      before: ['Aparte:', 'ni el efectivo ni el datáfono las calculan.'],
      after: ['Automáticas:', 'las comisiones del personal se calculan solas.'],
    },
  ],
];

export const STAFF: readonly (readonly [StaffApp, string, string])[] = [
  ['admin', 'Panel', 'Dueños y encargados'],
  ['operator', 'App de cobro', 'Personal del local'],
  ['tpv', 'TPV', 'Caja y barra'],
];
