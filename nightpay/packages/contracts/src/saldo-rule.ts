/**
 * El saldo no se devuelve (decisión del dueño, 17-nov-2026, con el consejo del
 * abogado): ni en efectivo ni a la tarjeta, entrara como entrara (efectivo,
 * tarjeta, bitcoin o un reservado). Se queda como saldo para las próximas
 * visitas. Siguen las devoluciones que corrigen un ERROR en un cobro: cobrado
 * dos veces, «Pagó después de cancelar», importe equivocado, devolver un cobro
 * a la tarjeta y «Devolver en efectivo» lo pagado con bitcoin por error.
 *
 * Las devoluciones del saldo pedidas antes de este cambio y aún pendientes
 * las puede terminar el encargado o el dueño como siempre; nada nuevo las empieza.
 */

/** 409: se ha intentado empezar una devolución del saldo nueva. */
export const SALDO_NO_SE_DEVUELVE_CODE = 'SALDO_NO_SE_DEVUELVE';
export const SALDO_NO_SE_DEVUELVE_MESSAGE = 'El saldo no se devuelve: se guarda para la próxima visita.';

/**
 * La frase de las pantallas: donde antes se pedía o se hacía la devolución, y
 * antes de cargar saldo (para que nadie cargue pensando que se le devuelve).
 */
export const SALDO_SE_QUEDA_TEXT = 'El saldo no se devuelve: se queda para la próxima visita.';
