/**
 * Código corto de confirmación de un pago («0C1»): lo ven a la vez el cliente
 * (su «Pagado») y el personal (su PAGADO, el TPV) y tienen que coincidir. Una
 * captura vieja o una página falsa no lo tienen. Son los 3 últimos caracteres
 * del id del pago, en mayúsculas.
 *
 * Una sola función para el API y las apps: si se cambia aquí, cambia en las
 * dos pantallas a la vez (si no, la comprobación dejaría de servir).
 */
export function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}
