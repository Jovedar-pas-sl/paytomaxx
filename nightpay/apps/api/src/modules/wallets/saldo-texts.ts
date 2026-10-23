/**
 * Cómo se le dice al usuario: el saldo de los clientes está en el panel en
 * «Clientes → Saldos» (la pestaña «Saldos»; «wallets» es solo el nombre
 * interno). Lo usan los avisos, el cierre de la noche y los errores del API.
 */
export const SALDOS_TAB_PATH = 'Clientes → Saldos';

/** Una recarga de saldo no se devuelve como un cobro: se devuelve el saldo. */
export const TOPUP_REFUND_TEXT = `Es una recarga de saldo: se devuelve desde ${SALDOS_TAB_PATH} → Devolver saldo`;
