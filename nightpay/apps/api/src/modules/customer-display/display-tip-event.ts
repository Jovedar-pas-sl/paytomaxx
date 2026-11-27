/**
 * Apunte en `payment_events` de la propina que el cliente elige en la
 * «Pantalla del cliente» de la barra (payload `{ tipCents }`, uno por cambio).
 * Solo en un cobro con tarjeta: con él, la página de pago marca la del ?tip=
 * del QR (pay-redirect.ts: withChosenTip). Con el saldo no hace falta (la
 * propina queda en el cobro del saldo y la confirman el PIN o el Face ID).
 */
export const DISPLAY_TIP_EVENT = 'display.tip';
