import type { PayLanguage } from '../payments/pay-i18n';

/**
 * Errores del API en las páginas del cliente (/w, /s y el «Pagado» de /pay).
 * El API responde en castellano y con un `code` estable; la página enseña el
 * texto de ese `code` en SU idioma (antes, una página en inglés enseñaba
 * «Ha tardado demasiado: vuelve a intentarlo»). Sin `code` conocido: en
 * castellano, el texto del API; en inglés, uno genérico (nunca castellano).
 *
 * `TOPUP_<motivo>`: el 409 WALLET_TOPUP_UNAVAILABLE con su `reason`.
 */
type ClientErrorTexts = Readonly<Record<string, string>>;

const ES: ClientErrorTexts = {
  generic: 'No se ha podido completar. Inténtalo otra vez.',
  network: 'Sin conexión: comprueba la red e inténtalo otra vez.',
  RATE_LIMITED: 'Demasiados intentos seguidos: espera un momento y vuelve a probar.',
  TRY_LATER: 'Ahora no se puede: inténtalo en unos minutos o pide ayuda en el local.',
  VENUE_PAUSED: 'Ahora mismo este local no acepta cobros ni recargas. Pregunta al personal.',
  PAYMENT_METHOD_DISABLED: 'Esta forma de pago está apagada en este local. Pregunta al personal.',
  WALLET_NOT_FOUND: 'No encontramos este saldo. Pide un enlace nuevo en el local.',
  WALLET_BLOCKED: 'Este saldo está bloqueado. Pregunta en el local.',
  WALLET_CLOSED: 'Este saldo ya está cerrado.',
  WALLET_INSUFFICIENT: 'No te llega el saldo para este cobro.',
  NOTHING_TO_REFUND: 'No te queda saldo que devolver.',
  WALLET_TOPUP_TOO_MANY: 'Demasiadas recargas seguidas: espera unos minutos y vuelve a probar.',
  WALLET_TOPUP_DAILY_LIMIT: 'Has llegado al máximo de recargas desde el móvil por hoy. Pide la recarga en el local.',
  WALLET_TOPUP_PENDING_LIMIT:
    'Tienes recargas a medias o sin confirmar por el banco: espera unos minutos o pide la recarga en el local.',
  WALLET_TOPUP_AMOUNT: 'Ese importe no vale: elige uno dentro de los límites, en euros enteros.',
  WALLET_TOPUP_STALE: 'Esta recarga ya no vale: vuelve a pulsar «Recargar».',
  PAGE_STALE: 'Vuelve a abrir la página e inténtalo otra vez.',
  TOPUP_blocked: 'Este saldo está bloqueado: no se puede recargar. Pregunta en el local.',
  TOPUP_merged: 'Esta recarga se sumó a tu otro saldo: recarga desde aquel.',
  TOPUP_closed: 'Este saldo ya está cerrado: no se puede recargar.',
  TOPUP_leaving: 'Has pedido que te devuelvan el saldo: ya no se puede recargar.',
  TOPUP_venue: 'Ahora no se puede recargar desde el móvil en este local. Pide la recarga en el local.',
  FACE_ID_REQUIRED: 'Confirma con Face ID, huella o el PIN de tu móvil.',
  FACE_ID_WRONG: 'Confirma con el Face ID de este saldo.',
  FACE_ID_UNKNOWN: 'Esta llave no tiene saldo aquí: actívala en la página de tu recarga.',
  FACE_ID_TIMEOUT: 'Ha tardado demasiado: vuelve a intentarlo.',
  FACE_ID_FAILED: 'No se ha podido comprobar tu Face ID: vuelve a intentarlo.',
  FACE_ID_USED: 'Esta confirmación ya se usó: vuelve a intentarlo.',
  FACE_ID_EXISTS: 'Tu saldo ya tiene Face ID activado.',
  FACE_ID_NOT_SET: 'Este saldo no tiene Face ID.',
  PIN_FORMAT: 'El PIN son 4 cifras.',
  PIN_MISMATCH: 'Los dos PIN no son iguales.',
  PIN_OBVIOUS: 'Ese PIN es demasiado fácil de adivinar: elige otro.',
  PIN_EXISTS: 'Este saldo ya tiene PIN.',
  PAYER_ONLY: 'Esto solo se puede hacer desde el móvil que pagó la recarga.',
  MERGE_BUSY: 'Esta recarga tiene otro pago a medias: inténtalo en unos minutos.',
  MERGE_NOT_ALLOWED: 'Esta recarga no se puede sumar a ese saldo.',
  CHARGE_NOT_PENDING: 'Este cobro ya no está pendiente.',
  CHARGE_EXPIRED: 'Este cobro ha caducado: pide al personal que lo repita.',
  CHARGE_OTHER_VENUE: 'Tu saldo no vale en este local.',
};

const EN: ClientErrorTexts = {
  generic: 'That did not work. Please try again.',
  network: 'No connection: check your network and try again.',
  RATE_LIMITED: 'Too many attempts in a row: wait a moment and try again.',
  TRY_LATER: 'Not available right now: try again in a few minutes or ask at the venue.',
  VENUE_PAUSED: 'This venue is not taking payments or top-ups right now. Ask the staff.',
  PAYMENT_METHOD_DISABLED: 'This payment method is turned off at this venue. Ask the staff.',
  WALLET_NOT_FOUND: 'We cannot find this balance. Ask the venue for a new link.',
  WALLET_BLOCKED: 'This balance is blocked. Ask at the venue.',
  WALLET_CLOSED: 'This balance is closed.',
  WALLET_INSUFFICIENT: 'Your balance is not enough for this charge.',
  NOTHING_TO_REFUND: 'There is no balance left to refund.',
  WALLET_TOPUP_TOO_MANY: 'Too many top-ups in a row: wait a few minutes and try again.',
  WALLET_TOPUP_DAILY_LIMIT: "You have reached today's limit for top-ups from your phone. Ask the venue to top up.",
  WALLET_TOPUP_PENDING_LIMIT:
    'You have top-ups still pending or unconfirmed by the bank: wait a few minutes or ask the venue to top up.',
  WALLET_TOPUP_AMOUNT: 'That amount is not valid: choose one within the limits, in whole euros.',
  WALLET_TOPUP_STALE: 'This top-up is no longer valid: tap "Top up" again.',
  PAGE_STALE: 'Reload the page and try again.',
  TOPUP_blocked: 'This balance is blocked: it cannot be topped up. Ask at the venue.',
  TOPUP_merged: 'This top-up was added to your other balance: top up from that one.',
  TOPUP_closed: 'This balance is closed: it cannot be topped up.',
  TOPUP_leaving: 'You asked for your balance back: it can no longer be topped up.',
  TOPUP_venue: 'Topping up from your phone is not available at this venue right now. Ask the venue to top up.',
  FACE_ID_REQUIRED: 'Confirm with Face ID, fingerprint or your phone PIN.',
  FACE_ID_WRONG: "Confirm with this balance's Face ID.",
  FACE_ID_UNKNOWN: 'This key has no balance here: turn it on from your top-up page.',
  FACE_ID_TIMEOUT: 'That took too long: try again.',
  FACE_ID_FAILED: 'We could not check your Face ID: try again.',
  FACE_ID_USED: 'This confirmation was already used: try again.',
  FACE_ID_EXISTS: 'Your balance already has Face ID on.',
  FACE_ID_NOT_SET: 'This balance has no Face ID.',
  PIN_FORMAT: 'The PIN is 4 digits.',
  PIN_MISMATCH: 'The two PINs do not match.',
  PIN_OBVIOUS: 'That PIN is too easy to guess: choose another one.',
  PIN_EXISTS: 'This balance already has a PIN.',
  PAYER_ONLY: 'This can only be done on the phone that paid the top-up.',
  MERGE_BUSY: 'This top-up has another payment in progress: try again in a few minutes.',
  MERGE_NOT_ALLOWED: 'This top-up cannot be added to that balance.',
  CHARGE_NOT_PENDING: 'This charge is no longer pending.',
  CHARGE_EXPIRED: 'This charge has expired: ask the staff to repeat it.',
  CHARGE_OTHER_VENUE: 'Your balance is not valid at this venue.',
};

export const CLIENT_ERROR_TEXT: Readonly<Record<PayLanguage, ClientErrorTexts>> = { es: ES, en: EN };

/** Lo que lee el JS de la página: los textos y si puede enseñar el del API (solo en castellano). */
export function clientErrorConfig(lang: PayLanguage): Record<string, string | boolean> {
  return { ...CLIENT_ERROR_TEXT[lang], useServer: lang === 'es' };
}

/**
 * npErr(e, E): el texto del error `e` (de pkPost: status, code, reason,
 * message) con los textos E de clientErrorConfig. Sin barras invertidas: va
 * dentro de plantillas de TypeScript.
 */
export const CLIENT_ERROR_JS = `
function npErr(e,E){if(!e)return E.generic;
 var k=e.code==='WALLET_TOPUP_UNAVAILABLE'?'TOPUP_'+(E['TOPUP_'+e.reason]?e.reason:'venue'):e.code;
 if(k&&typeof E[k]==='string')return E[k];
 if(e.status===429)return E.RATE_LIMITED;
 if(!e.status)return e.name==='TypeError'?E.network:E.generic;
 return E.useServer&&e.message&&e.message!=='Error'?e.message:E.generic;}
`;
