import type { PayClosedReason } from './pay-redirect';

/**
 * Textos de las páginas del cliente (/pay/...), en español e inglés.
 * Discretos: sin nombres internos ni tipo de servicio.
 */
export type PayLanguage = 'es' | 'en';

/** Español para quien tiene el móvil en español o en otra lengua de España; si no, inglés. */
export function resolveLanguage(query: unknown, acceptLanguage: string | undefined): PayLanguage {
  if (query === 'es' || query === 'en') return query;
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (first === '' || /^(es|ca|gl|eu)\b/.test(first)) return 'es';
  return 'en';
}

export type PayErrorKey = 'expired' | 'notFound' | 'inProgress' | 'gateway' | 'generic';

export interface PayText {
  htmlLang: PayLanguage;
  locale: string;
  secure: string;
  otherLanguage: { code: PayLanguage; label: string };
  // Página de pago
  youPay: string;
  pay: string;
  tipLegend: string;
  noTip: string;
  total: string;
  payWith: (wallet: string) => string;
  payCard: string;
  inAppWarning: (app: string) => string;
  statement: (name: string) => string;
  /** Recarga de saldo: su código, activar Face ID o sumarla a su saldo. */
  walletTitle: string;
  walletHow: string;
  faceIdOn: string;
  faceIdButton: string;
  faceIdDone: string;
  mergeAsk: string;
  mergeButton: string;
  mergeDone: string;
  faceIdUnsupported: string;
  pinAsk: string;
  pinLabel: string;
  pinRepeat: string;
  pinButton: string;
  pinDone: string;
  pinOn: string;
  pinFormat: string;
  pinMismatch: string;
  walletMore: string;
  expiresIn: string;
  // Hacia el banco
  openingTitle: string;
  openingHint: string;
  continueToBank: string;
  // Pagado
  paidTitle: string;
  confirmedAt: (time: string) => string;
  includesTip: (tip: string) => string;
  codeLabel: string;
  codeHint: string;
  clockLabel: string;
  receiptLink: string;
  walletReady: string;
  walletOpen: string;
  walletElsewhere: string;
  // Comprobando
  processingTitle: string;
  processingBody: string;
  processingNewCharge: string;
  // Resultado
  notFoundTitle: string;
  notFoundBody: string;
  deniedTitle: string;
  deniedBody: string;
  tryAgain: string;
  closed: Record<PayClosedReason, { title: string; body: string }>;
  unavailableTitle: string;
  errors: Record<PayErrorKey, string>;
  // Justificante
  receipt: {
    title: string;
    date: string;
    amount: string;
    tip: string;
    total: string;
    method: string;
    wallet: string;
    card: string;
    authCode: string;
    order: string;
    code: string;
    save: string;
    back: string;
    noPersonalData: string;
  };
}

const ES: PayText = {
  htmlLang: 'es',
  locale: 'es-ES',
  secure: 'Pago seguro',
  otherLanguage: { code: 'en', label: 'English' },
  youPay: 'Vas a pagar',
  pay: 'Pagar',
  tipLegend: '¿Quieres dejar propina?',
  noTip: 'Sin propina',
  total: 'Total',
  payWith: (wallet) => `Pagar con ${wallet}`,
  payCard: 'Pagar con tarjeta',
  inAppWarning: (app) =>
    `Estás en el navegador de ${app}. Para pagar con Apple Pay o Google Pay, ábrelo en Safari o Chrome: toca ··· y «Abrir en el navegador». Con tarjeta puedes pagar aquí.`,
  statement: (name) => `En tu extracto aparecerá como «${name}».`,
  walletTitle: 'Tu saldo',
  walletHow: 'Dos formas de pagar, y solo tú: con tu móvil (escaneas el QR de la chica y Face ID) o sin sacarlo (dices tu código y tecleas tu PIN en el móvil de ella).',
  faceIdOn: '🔒 Face ID activado. Ya puedes pagar con tu saldo.',
  faceIdButton: 'Activar Face ID',
  faceIdDone: '✓ Face ID activado. Ya puedes pagar con tu saldo.',
  mergeAsk: '¿Ya tenías saldo con Face ID? Súmale esta recarga:',
  mergeButton: 'Sumar a mi saldo',
  mergeDone: '✓ Sumado a tu saldo.',
  faceIdUnsupported: 'Tu móvil no permite Face ID aquí: paga con tu PIN.',
  pinAsk: 'Para pagar sin sacar el móvil, elige un PIN de 4 cifras:',
  pinLabel: 'PIN',
  pinRepeat: 'Repite el PIN',
  pinButton: 'Guardar PIN',
  pinDone: '✓ PIN guardado. Para pagar sin móvil, di tu código y teclea tu PIN.',
  pinOn: '🔒 Tu saldo ya tiene PIN. Si no lo has elegido tú, avisa al encargado.',
  pinFormat: 'El PIN son 4 cifras',
  pinMismatch: 'Los dos PIN no son iguales',
  walletMore: 'Ver mi saldo y movimientos',
  expiresIn: 'Caduca en',
  openingTitle: 'Abriendo el pago…',
  openingHint: 'Si no avanza en 2 segundos, pulsa el botón.',
  continueToBank: 'Continuar al pago',
  paidTitle: 'Pagado',
  confirmedAt: (time) => `Confirmado por el banco a las ${time}`,
  includesTip: (tip) => `Incluye ${tip} de propina. ¡Gracias!`,
  codeLabel: 'Código de confirmación',
  codeHint: 'Debe coincidir con el que ve el personal',
  clockLabel: 'Hora actual',
  receiptLink: 'Ver justificante',
  walletReady: 'Tu saldo ya está cargado. Ábrelo y guárdalo: ahí ves el saldo, el código para pagar y aceptas cada gasto.',
  walletOpen: 'Abrir mi saldo',
  walletElsewhere: 'Tu saldo se abre en el móvil con el que pagaste. Si no lo encuentras, pide en el local un enlace nuevo.',
  processingTitle: 'Comprobando el pago',
  processingBody:
    'Estamos esperando la confirmación del banco. No vuelvas a pagar: esta pantalla se actualiza sola.',
  processingNewCharge:
    'Si cerraste la página del banco sin pagar, en unos minutos podrás volver a intentarlo con el mismo código.',
  notFoundTitle: 'No encontramos este pago',
  notFoundBody: 'Si te han cobrado, enséñale el cargo de tu app del banco al personal.',
  deniedTitle: 'El banco no ha aceptado el pago',
  deniedBody: 'No se te ha cobrado. Puedes probar con otra tarjeta o con Apple Pay / Google Pay.',
  tryAgain: 'Probar otra vez',
  closed: {
    expired: { title: 'Este cobro ha caducado', body: 'No se te ha cobrado. Pide uno nuevo al personal.' },
    failed: { title: 'Este cobro no se completó', body: 'No se te ha cobrado. Pide uno nuevo al personal.' },
    canceled: { title: 'Este cobro se ha cancelado', body: 'No se te ha cobrado.' },
    unconfirmed: {
      title: 'Sin confirmación del banco',
      body: 'Si ves el cargo en tu app del banco, enséñaselo al personal y lo resuelven.',
    },
    'too-many-attempts': {
      title: 'Demasiados intentos',
      body: 'Este código ya no admite más intentos. Pide un cobro nuevo al personal.',
    },
  },
  unavailableTitle: 'Cobro no disponible',
  errors: {
    expired: 'Este cobro ha caducado. Pide uno nuevo al personal.',
    notFound: 'Este cobro ya no existe. Pide uno nuevo al personal.',
    inProgress: 'Este cobro ya se está procesando. Espera unos segundos y vuelve a escanear.',
    gateway: 'El banco no responde ahora mismo. Vuelve a escanear el código en unos segundos.',
    generic: 'No se ha podido continuar con el cobro. Pide uno nuevo al personal.',
  },
  receipt: {
    title: 'Justificante de pago',
    date: 'Fecha',
    amount: 'Importe',
    tip: 'Propina',
    total: 'Total cobrado',
    method: 'Método',
    wallet: 'Apple Pay o Google Pay',
    card: 'Tarjeta',
    authCode: 'Autorización',
    order: 'Referencia',
    code: 'Código',
    save: 'Guardar o imprimir',
    back: 'Volver',
    noPersonalData: 'Este justificante no contiene datos personales.',
  },
};

const EN: PayText = {
  htmlLang: 'en',
  locale: 'en-GB',
  secure: 'Secure payment',
  otherLanguage: { code: 'es', label: 'Español' },
  youPay: 'You are paying',
  pay: 'Pay',
  tipLegend: 'Add a tip?',
  noTip: 'No tip',
  total: 'Total',
  payWith: (wallet) => `Pay with ${wallet}`,
  payCard: 'Pay by card',
  inAppWarning: (app) =>
    `You are in the ${app} browser. To pay with Apple Pay or Google Pay, open this page in Safari or Chrome: tap ··· and "Open in browser". You can pay by card here.`,
  statement: (name) => `It will show on your statement as "${name}".`,
  walletTitle: 'Your balance',
  walletHow: 'Two ways to pay, and only you can: with your phone (scan the staff QR and use Face ID) or without it (say your code and type your PIN on their phone).',
  faceIdOn: '🔒 Face ID is on. You can now pay with your balance.',
  faceIdButton: 'Turn on Face ID',
  faceIdDone: '✓ Face ID is on. You can now pay with your balance.',
  mergeAsk: 'Already have a balance with Face ID? Add this top-up to it:',
  mergeButton: 'Add to my balance',
  mergeDone: '✓ Added to your balance.',
  faceIdUnsupported: 'Your phone cannot use Face ID here: pay with your PIN.',
  pinAsk: 'To pay without your phone, choose a 4-digit PIN:',
  pinLabel: 'PIN',
  pinRepeat: 'Repeat PIN',
  pinButton: 'Save PIN',
  pinDone: '✓ PIN saved. To pay without your phone, say your code and type your PIN.',
  pinOn: '🔒 Your balance already has a PIN. If you did not choose it, tell the manager.',
  pinFormat: 'The PIN is 4 digits',
  pinMismatch: 'The two PINs do not match',
  walletMore: 'See my balance and activity',
  expiresIn: 'Expires in',
  openingTitle: 'Opening the payment…',
  openingHint: 'If nothing happens in 2 seconds, tap the button.',
  continueToBank: 'Continue to payment',
  paidTitle: 'Paid',
  confirmedAt: (time) => `Confirmed by the bank at ${time}`,
  includesTip: (tip) => `Includes a ${tip} tip. Thank you!`,
  codeLabel: 'Confirmation code',
  codeHint: 'It must match the one the staff see',
  clockLabel: 'Current time',
  receiptLink: 'View receipt',
  walletReady: 'Your balance is loaded. Open it and save it: it shows your balance and your code, and you accept each charge there.',
  walletOpen: 'Open my balance',
  walletElsewhere: "Your balance opens on the phone you paid with. If you can't find it, ask the venue for a new link.",
  processingTitle: 'Checking the payment',
  processingBody:
    'We are waiting for the bank to confirm. Do not pay again: this page updates by itself.',
  processingNewCharge:
    'If you closed the bank page without paying, you can try again with the same code in a few minutes.',
  notFoundTitle: 'We cannot find this payment',
  notFoundBody: 'If you have been charged, show the charge in your banking app to the staff.',
  deniedTitle: 'The bank declined the payment',
  deniedBody: 'You have not been charged. Try another card or Apple Pay / Google Pay.',
  tryAgain: 'Try again',
  closed: {
    expired: { title: 'This payment has expired', body: 'You have not been charged. Ask the staff for a new one.' },
    failed: { title: 'This payment did not go through', body: 'You have not been charged. Ask the staff for a new one.' },
    canceled: { title: 'This payment was cancelled', body: 'You have not been charged.' },
    unconfirmed: {
      title: 'No confirmation from the bank',
      body: 'If you see the charge in your banking app, show it to the staff and they will sort it out.',
    },
    'too-many-attempts': {
      title: 'Too many attempts',
      body: 'This code cannot be used again. Ask the staff for a new payment.',
    },
  },
  unavailableTitle: 'Payment not available',
  errors: {
    expired: 'This payment has expired. Ask the staff for a new one.',
    notFound: 'This payment no longer exists. Ask the staff for a new one.',
    inProgress: 'This payment is already being processed. Wait a few seconds and scan again.',
    gateway: 'The bank is not responding right now. Scan the code again in a few seconds.',
    generic: 'The payment could not continue. Ask the staff for a new one.',
  },
  receipt: {
    title: 'Payment receipt',
    date: 'Date',
    amount: 'Amount',
    tip: 'Tip',
    total: 'Total charged',
    method: 'Method',
    wallet: 'Apple Pay or Google Pay',
    card: 'Card',
    authCode: 'Authorisation',
    order: 'Reference',
    code: 'Code',
    save: 'Save or print',
    back: 'Back',
    noPersonalData: 'This receipt contains no personal data.',
  },
};

export const PAY_TEXT: Record<PayLanguage, PayText> = { es: ES, en: EN };

/**
 * Traduce errores técnicos a una frase para el cliente. Nunca se muestran
 * detalles internos.
 */
export function payErrorKey(message: string): PayErrorKey {
  const m = message.toLowerCase();
  if (m.includes('expired') || m.includes('expirado') || m.includes('caduca')) return 'expired';
  if (m.includes('not found') || m.includes('no encontrado')) return 'notFound';
  if (m.includes('already') || m.includes('in progress')) return 'inProgress';
  if (m.includes('gateway') || m.includes('pasarela') || m.includes('redsys') || m.includes('sis')) {
    return 'gateway';
  }
  return 'generic';
}
