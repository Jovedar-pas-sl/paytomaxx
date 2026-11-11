// Los botones de cada fila de Cobros (panel): su texto y su `title` corto (al
// pasar el ratón). Los usan CobroRowActions, CobrosTable y el tutorial del «?»
// de Cobros (tours.ts), que los nombra tal cual. Puro, sin pantalla.

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
  detail: 'Qué, cuándo, quién cobró, cómo se pagó y lo del banco',
  reverse: 'Devuelve el importe al saldo del cliente. Pide motivo y 2FA',
  resolve: 'Di si el banco lo cobró, después de mirarlo en su portal',
  bankRefund: 'Apunta una devolución que ya hiciste en el portal de BBVA',
  refund: 'Devuelve el dinero a la tarjeta del cliente',
  refunds: 'Lo devuelto de este cobro y si el banco lo confirmó',
};
