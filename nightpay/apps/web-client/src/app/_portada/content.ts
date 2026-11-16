import type { StaffApp } from '@/lib/customer-pages';

/**
 * Textos de la portada. Regla: solo lo que OxioPay hace hoy (comprobado en el
 * código de main o ya publicado en la portada anterior). Sin cifras, reseñas
 * ni promesas. Una palabra por cosa: ficha, saldo, cargar, cobro, Pagado,
 * personal.
 *
 * Bitcoin (decisión del 16-nov): solo para cargar saldo en recepción y, cuando
 * salgan, para pagar reservados (señal y resto). Nunca para pagar en la barra.
 * Cada local elige si lo acepta y ese saldo se devuelve en euros.
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
  reservado: { src: '/portada/reservado.webp', width: 440, height: 952, alt: 'Reserva de un reservado con señal (próximamente)' },
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
    text: 'El personal te lo enseña en su móvil o en el datáfono. No hace falta instalar nada ni registrarse.',
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
  ['Tu saldo:', 'prepago, protegido con PIN o Face ID.'],
  ['Lo que te sobra:', 'te lo devolvemos cuando lo pidas.'],
];

export type VenueIcon = 'qr' | 'bitcoin' | 'heart' | 'chart' | 'percent' | 'bell';

export const FOR_VENUES: readonly (readonly [VenueIcon, string, string])[] = [
  ['qr', 'Cobra como quieras', 'Con QR, con datáfono o con el saldo del cliente.'],
  ['bitcoin', 'Bitcoin, si quieres', 'Tus clientes cargan su saldo con bitcoin en recepción.'],
  [
    'heart',
    'Fideliza',
    'El saldo de tus clientes vale en todos tus locales y les espera para la próxima visita, también en Google Wallet.',
  ],
  ['chart', 'Lo cobrado, cada noche', 'Un panel con lo cobrado cada noche.'],
  ['percent', 'Comisiones del personal', 'Se calculan solas.'],
  ['bell', 'Avisos al momento', 'En Telegram.'],
];

export const BITCOIN_POINTS: readonly Point[] = [
  ['Solo para cargar saldo:', 'en la barra no se paga con bitcoin; pagas con tu saldo.'],
  ['El local decide:', 'cada local elige si acepta bitcoin.'],
  ['Lightning o en la red:', 'con Lightning llega al momento; en la red, con 1 confirmación.'],
  ['En euros:', 'el saldo que cargas con bitcoin se devuelve en euros.'],
];

/** Efectivo y datáfono frente a OxioPay: solo hechos. */
export const VERSUS: readonly (readonly { topic: string; before: Point; after: Point }[])[] = [
  [
    {
      topic: 'El justificante',
      before: ['En papel:', 'un ticket, si lo pides.'],
      after: ['En tu móvil:', 'ves «Pagado» en pantalla y puedes guardar el justificante.'],
    },
    {
      topic: 'Si se pierde',
      before: ['Sin vuelta atrás:', 'el efectivo que se pierde no se recupera.'],
      after: ['Saldo bloqueado:', 'si pierdes la ficha o el móvil, avisa al personal y bloqueamos el saldo para que nadie lo use.'],
    },
  ],
  [
    {
      topic: 'Al cerrar la noche',
      before: ['A mano:', 'el efectivo se cuenta a mano y cada datáfono da su propio cierre.'],
      after: ['Un panel:', 'con lo cobrado cada noche.'],
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
