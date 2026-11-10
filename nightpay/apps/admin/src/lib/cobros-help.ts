// Ayuda de Cobros (panel): la línea de debajo del título y «Cómo leer esta
// tabla» (columnas, botones de cada fila, estados y qué hacer en los casos que
// el panel resuelve). Sale del código: las columnas de CobrosTable, los
// botones de CobroRowActions y sus diálogos, y las palabras de cobro-status.
// Si cambia uno de ellos, cobros-help.test.ts lo dice. Pura, sin pantalla.

import { PaymentStatusSchema, type CobroRow } from '@nightpay/contracts';
import { cobroStatus, type CobroStatusView } from './cobro-status';

/** La línea de ayuda de debajo de «Cobros» (una sola, en t2). */
export const COBROS_HINT = 'Cada fila es un cobro, el más reciente arriba; la lista se actualiza sola.';

export const COBROS_HOWTO_SUMMARY = 'Cómo leer esta tabla';

export interface HelpItem {
  term: string;
  text: string;
}

/** Una por columna de la tabla, con su cabecera tal cual. */
export const COBROS_COLUMNS_HELP: readonly HelpItem[] = [
  { term: 'Hora', text: 'Día y hora del cobro, en la hora del local.' },
  {
    term: 'Ref',
    text: 'La referencia corta del cobro (C-0025): la misma que ve la chica al cobrar y el cliente en sus movimientos.',
  },
  {
    term: 'Código',
    text: 'Los 3 caracteres que ven a la vez el cliente y el personal al pagar, y que tienen que coincidir. Los cobros solo con saldo no lo llevan.',
  },
  {
    term: 'Ref. banco',
    text: 'El número de pedido en el banco y, tras «aut.», la autorización: con ellos se encuentra el cobro en el portal del banco.',
  },
  { term: 'Importe', text: 'Lo cobrado. Debajo, si las hubo, la propina y la comisión del servicio que pagó el cliente encima.' },
  { term: 'Estado', text: 'En qué punto está el cobro (lo que significa cada uno, en esta ayuda).' },
  {
    term: 'Quién cobró',
    text: 'Quién hizo el cobro. Si su nombre va subrayado (quien tiene ficha propia en el panel), tócalo para abrir su ficha. «Desde casa»: lo cargó el cliente con el enlace del local, antes de llegar.',
  },
  {
    term: 'Sección',
    text: 'De qué parte de la carta es la venta, con su color. «Varias» si lleva de varias (con el ratón encima sale el reparto); «Recarga de saldo» si es una recarga.',
  },
  { term: 'Cómo pagó', text: 'Tarjeta, Apple Pay / Google Pay, datáfono o saldo. Toca el saldo para abrir su ficha.' },
  {
    term: 'Servicio',
    text: 'Lo que se vendió («2× Copa · Habitación»). «Invitación a…»: la copa a la que se invitó a esa chica.',
  },
  { term: 'Acciones', text: 'Los botones de cada cobro (lo que hace cada uno, en esta ayuda).' },
];

export type CobroAction = 'detail' | 'reverse' | 'resolve' | 'bankRefund' | 'refund' | 'refunds';

/** El texto de cada botón de la fila, tal cual. */
export const COBRO_ACTION_LABELS: Readonly<Record<CobroAction, string>> = {
  detail: 'Ver detalle',
  reverse: 'Anular cobro',
  resolve: 'Resolver',
  bankRefund: 'Devolución BBVA',
  refund: 'Reembolsar',
  refunds: 'Devoluciones',
};

/** El `title` corto de cada botón (al pasar el ratón). */
export const COBRO_ACTION_TITLES: Readonly<Record<CobroAction, string>> = {
  detail: 'Código, pedido y autorización del banco, para copiarlos',
  reverse: 'Devuelve el importe al saldo del cliente. Pide motivo y 2FA',
  resolve: 'Di si el banco lo cobró, después de mirarlo en su portal',
  bankRefund: 'Apunta una devolución que ya hiciste en el portal de BBVA',
  refund: 'Devuelve el dinero a la tarjeta del cliente',
  refunds: 'Lo devuelto de este cobro y si el banco lo confirmó',
};

const ACTION_TEXT: Readonly<Record<CobroAction, string>> = {
  detail:
    'En todos los cobros. Enseña el código de confirmación, el pedido y la autorización del banco, cada uno con «Copiar», y los intentos de pago (aprobado, denegado o sin respuesta).',
  reverse:
    'En los cobros pagados con el saldo (dueño y encargado). El importe vuelve al saldo del cliente. Pide el motivo y el código de tu app de verificación (2FA).',
  resolve:
    'Solo el dueño, en los cobros «Sin confirmar» o «Esperando pago» desde hace más de 15 minutos. Búscalo en el portal del banco y di si se cobró: «Sí, se cobró» pide el código de autorización del banco, cómo lo has comprobado y el 2FA; «No se cobró», solo cómo lo has comprobado.',
  bankRefund:
    'Solo el dueño, en los cobros con tarjeta de BBVA que están «Pagado» o «Devuelto en parte». La devolución se hace en el portal de BBVA y aquí se apunta: importe, día, referencia del banco (opcional) y motivo. OxioPay ajusta el cobro y descuenta la parte de la chica.',
  refund:
    'En los cobros con tarjeta de otra pasarela que están «Pagado» o «Devuelto en parte» (dueño y encargado): OxioPay devuelve el dinero a la tarjeta. Pide el importe y la razón (opcional); desde 100\u00a0€ devueltos, de una vez o sumando, también el 2FA. Al encargado, desde el importe que haya fijado el dueño, se le pide a él («Pedir al dueño»).',
  refunds:
    'Sale cuando el cobro ya tiene algo devuelto o reservado. Enseña cada devolución: «Hecha», «No hecha» o «Sin confirmar». Una «Sin confirmar» la resuelve el dueño pasados 2 minutos.',
};

/** Los botones de la fila, en el orden en que salen. */
export const COBRO_ACTIONS_ORDER: readonly CobroAction[] = ['detail', 'reverse', 'resolve', 'bankRefund', 'refund', 'refunds'];

export const COBROS_ACTIONS_HELP: readonly HelpItem[] = COBRO_ACTIONS_ORDER.map((a) => ({
  term: COBRO_ACTION_LABELS[a],
  text: ACTION_TEXT[a],
}));

export interface StateHelp extends CobroStatusView {
  text: string;
}

type StatusKey = Pick<CobroRow, 'kind' | 'status'>;

/** Qué significa cada estado, en el orden en que más se ven. La palabra y el color, de cobro-status. */
const STATES: ReadonlyArray<[StatusKey, string]> = [
  [{ kind: 'PAYMENT', status: 'AUTHORIZED' }, 'Cobrado, con tarjeta, móvil, datáfono o saldo.'],
  [{ kind: 'PAYMENT', status: 'PARTIALLY_REFUNDED' }, 'Se devolvió una parte; lo que queda aún se puede devolver.'],
  [{ kind: 'PAYMENT', status: 'REFUNDED' }, 'Se devolvió entero.'],
  [
    { kind: 'PAYMENT', status: 'AUTHORIZING' },
    'El cliente está pagando y falta la respuesta del banco. Si pasan 15 minutos, el dueño lo puede resolver.',
  ],
  [{ kind: 'PAYMENT', status: 'ORPHAN' }, 'El banco no confirmó si se cobró: hay que mirarlo en su portal y resolverlo.'],
  [{ kind: 'PAYMENT', status: 'CREATED' }, 'Abierto y sin pagar todavía. Si nadie lo paga a tiempo, caduca solo.'],
  [{ kind: 'PAYMENT', status: 'AWAITING_CAPTURE' }, 'Abierto, esperando el pago; aún no se ha cobrado nada. También caduca solo.'],
  [{ kind: 'PAYMENT', status: 'FAILED' }, 'No se cobró: el banco lo denegó o el pago no llegó a hacerse.'],
  [{ kind: 'PAYMENT', status: 'EXPIRED' }, 'Nadie lo pagó a tiempo y se cerró solo. No se cobró.'],
  [
    { kind: 'PAYMENT', status: 'CANCELED' },
    'Se cerró sin cobrarlo con la tarjeta. Si debajo pone «Cobrado dos veces», lo pagó el saldo y después el banco aprobó también la tarjeta: si no se devolvió sola, sale en Avisos.',
  ],
  [{ kind: 'SALDO', status: 'REVERSED' }, 'Un cobro del saldo anulado: el importe volvió al saldo del cliente.'],
];

export const COBRO_STATES_HELP: readonly StateHelp[] = STATES.map(([row, text]) => ({ ...cobroStatus(row), text }));

/** Todos los estados que puede enseñar la tabla (tarjeta y saldo), para comprobar que la ayuda no se deja ninguno. */
export function tableStatusLabels(): string[] {
  const rows: StatusKey[] = [
    ...PaymentStatusSchema.options.map((status) => ({ kind: 'PAYMENT' as const, status })),
    { kind: 'SALDO', status: 'ACCEPTED' },
    { kind: 'SALDO', status: 'REVERSED' },
  ];
  return [...new Set(rows.map((r) => cobroStatus(r).label))];
}

/** «Si pasa esto → haz esto»: solo casos que se resuelven aquí, con el botón y lo que pide. */
export const COBROS_CASES_HELP: readonly HelpItem[] = [
  {
    term: 'El cliente dice que le cobraron dos veces',
    text: 'Abre «Ver detalle» de su cobro: si hay dos intentos «Aprobado», el banco cobró dos veces (también sale en Avisos). El dueño devuelve uno en el portal de BBVA y lo apunta en ese cobro con «Devolución BBVA»: importe, día y motivo.',
  },
  {
    term: 'Pide que le devuelvan',
    text: 'Con tarjeta de BBVA: «Devolución BBVA» (el dueño), después de hacerla en el portal de BBVA. Con otra pasarela: «Reembolsar», con el importe; desde 100\u00a0€, también el 2FA. Pagado con el saldo: «Anular cobro», con motivo y 2FA; el dinero vuelve a su saldo.',
  },
  {
    term: 'Un cobro lleva más de 15 minutos en «Esperando pago»',
    text: '«Resolver» (el dueño). Búscalo en el portal del banco por importe, hora o pedido. Si se cobró, «Sí, se cobró», con el código de autorización, cómo lo has comprobado y el 2FA. Si no, «No se cobró» y cómo lo has comprobado.',
  },
  {
    term: 'El banco no confirma un cobro o una devolución',
    text: 'Un cobro «Sin confirmar»: «Resolver», como el caso de arriba. Una devolución sin confirmar: «Devoluciones» en ese cobro; pasados 2 minutos, el dueño la mira en el portal y pulsa «Resolver»: «Sí, está hecha» o «No se hizo», con lo que vio. No la repitas.',
  },
];
