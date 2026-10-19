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

/**
 * Aviso que no asusta: qué ha pasado, «No se te ha cobrado nada» cuando es
 * verdad, y UNA acción (un botón `retry` o una indicación `hint`).
 */
export interface PayNotice {
  title: string;
  body: string;
  notCharged: boolean;
  hint?: string;
  /** Texto del botón para volver a la página del cobro. */
  retry?: string;
}

/** Cómo se llama el desbloqueo del móvil en cada plataforma. */
export interface UnlockText {
  title: string;
  button: string;
  done: string;
}

export interface PayText {
  htmlLang: PayLanguage;
  locale: string;
  secure: string;
  otherLanguage: { code: PayLanguage; label: string };
  // Página de pago
  youPay: string;
  payPrefix: string;
  sending: string;
  methods: string;
  methodsCard: string;
  /** El botón abre directamente la cartera del móvil (Apple Pay / Google Pay). */
  methodsWallet: (wallet: string) => string;
  payByCard: string;
  tipLegend: string;
  noTip: string;
  tipOther: string;
  tipOtherLabel: string;
  tipMax: (max: string) => string;
  tipToStaff: string;
  total: string;
  inAppWarning: (app: string) => string;
  statement: (name: string) => string;
  expiresIn: string;
  // Hacia el banco
  openingTitle: string;
  openingHint: string;
  continueToBank: string;
  // Pagado
  paidTitle: string;
  alreadyPaidTitle: string;
  agoPrefix: string;
  agoSuffix: string;
  notNewPayment: string;
  confirmedAt: (time: string) => string;
  paidFromBalanceAt: (time: string) => string;
  includesTip: (tip: string) => string;
  codeLabel: string;
  codeHint: string;
  clockLabel: string;
  receiptLink: string;
  walletReady: string;
  walletOpen: string;
  walletElsewhere: string;
  // Recarga que creó el saldo: activar el pago desbloqueando el móvil
  walletReadyTitle: string;
  unlock: { ios: UnlockText; android: UnlockText; other: UnlockText };
  unlockWhy: string;
  unlockWaiting: string;
  unlockAfter: string;
  unlockUnsupported: string;
  notNow: string;
  notNowAfter: string;
  mergeHint: string;
  // Comprobando
  processingTitle: string;
  processingBody: string;
  processingNewCharge: string;
  // Avisos
  notCharged: string;
  notFound: PayNotice;
  denied: PayNotice;
  closed: Record<PayClosedReason, PayNotice>;
  errors: Record<PayErrorKey, PayNotice>;
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

const ASK_STAFF_ES = 'Pide uno nuevo al personal.';
const ASK_STAFF_EN = 'Ask the staff for a new one.';

const ES: PayText = {
  htmlLang: 'es',
  locale: 'es-ES',
  secure: 'Pago seguro',
  otherLanguage: { code: 'en', label: 'English' },
  youPay: 'Vas a pagar',
  payPrefix: 'Pagar',
  sending: 'Enviando…',
  methods: 'Apple Pay · Google Pay · tarjeta',
  methodsCard: 'Con tarjeta',
  methodsWallet: (wallet) => `Se abre ${wallet}`,
  payByCard: 'Pagar con tarjeta',
  tipLegend: '¿Quieres dejar propina?',
  noTip: 'Sin propina',
  tipOther: 'Otra',
  tipOtherLabel: 'Propina en euros',
  tipMax: (max) => `Como mucho ${max}`,
  tipToStaff: 'Va entera para el personal',
  total: 'Total',
  inAppWarning: (app) =>
    `Estás en el navegador de ${app}. Para pagar con Apple Pay o Google Pay, ábrelo en Safari o Chrome: toca ··· y «Abrir en el navegador». Con tarjeta puedes pagar aquí.`,
  statement: (name) => `En tu extracto: «${name}»`,
  expiresIn: 'Caduca en',
  openingTitle: 'Abriendo el pago…',
  openingHint: 'Si no avanza en 2 segundos, pulsa el botón.',
  continueToBank: 'Continuar al pago',
  paidTitle: 'Pagado',
  alreadyPaidTitle: 'Ya pagado',
  agoPrefix: 'hace ',
  agoSuffix: '',
  notNewPayment: 'No es un pago nuevo.',
  confirmedAt: (time) => `Confirmado por el banco a las ${time}`,
  paidFromBalanceAt: (time) => `Pagado con tu saldo a las ${time}`,
  includesTip: (tip) => `Incluye ${tip} de propina. ¡Gracias!`,
  codeLabel: 'Código',
  codeHint: 'Debe coincidir con el que ve el personal',
  clockLabel: 'Hora actual',
  receiptLink: 'Ver justificante',
  walletReady: 'Tu saldo ya está cargado. Ábrelo y guárdalo: ahí ves el saldo y el código para pagar.',
  walletOpen: 'Ver mi saldo',
  walletElsewhere: 'Tu saldo se abre en el móvil con el que pagaste. Si no lo encuentras, pide en el local un enlace nuevo.',
  walletReadyTitle: 'Tu saldo está listo',
  unlock: {
    ios: { title: 'Paga con Face ID', button: 'Activar Face ID', done: 'Face ID activado.' },
    android: {
      title: 'Paga con tu huella o bloqueo de pantalla',
      button: 'Activar huella o bloqueo',
      done: 'Huella o bloqueo de pantalla activado.',
    },
    other: {
      title: 'Paga desbloqueando el móvil',
      button: 'Activar desbloqueo',
      done: 'Pago desbloqueando el móvil activado.',
    },
  },
  unlockWhy:
    'Para pagar con tu saldo, escaneas el QR del personal y desbloqueas el móvil. Solo quien desbloquee este móvil puede gastar tu saldo.',
  unlockWaiting: 'Sigue los pasos de tu móvil…',
  unlockAfter: 'Para pagar, escanea el QR del personal y desbloquea el móvil.',
  unlockUnsupported:
    'Este navegador no permite pagar desbloqueando el móvil. En tu saldo puedes elegir un PIN para pagar sin sacarlo.',
  notNow: 'Ahora no',
  notNowAfter: 'Puedes activarlo cuando quieras desde tu saldo.',
  mergeHint: '¿Ya tenías saldo en este móvil? Súmale esta recarga',
  processingTitle: 'Comprobando el pago',
  processingBody:
    'Estamos esperando la confirmación del banco. No vuelvas a pagar: esta pantalla se actualiza sola.',
  processingNewCharge:
    'Si cerraste la página del banco sin pagar, en unos minutos podrás volver a intentarlo con el mismo código.',
  notCharged: 'No se te ha cobrado nada.',
  notFound: {
    title: 'No encontramos este pago',
    body: 'Puede que el enlace esté incompleto.',
    notCharged: false,
    hint: 'Si te han cobrado, enséñale el cargo de tu app del banco al personal.',
  },
  denied: {
    title: 'El banco no ha aceptado el pago',
    body: 'A veces pasa. Prueba con otra tarjeta, o con Apple Pay o Google Pay.',
    notCharged: true,
    retry: 'Probar con otro método',
  },
  closed: {
    expired: {
      title: 'Este cobro ha caducado',
      body: 'Los cobros caducan a los pocos minutos para que nadie los use después.',
      notCharged: true,
      hint: ASK_STAFF_ES,
    },
    failed: { title: 'Este cobro no se completó', body: '', notCharged: true, hint: ASK_STAFF_ES },
    canceled: {
      title: 'Este cobro se ha cancelado',
      body: '',
      notCharged: true,
      hint: 'Si aún tienes que pagar, pide uno nuevo al personal.',
    },
    unconfirmed: {
      title: 'Sin confirmación del banco',
      body: 'Aún no sabemos si el banco lo ha cobrado.',
      notCharged: false,
      hint: 'Si ves el cargo en tu app del banco, enséñaselo al personal y lo resuelven.',
    },
    'too-many-attempts': {
      title: 'Demasiados intentos',
      body: 'Este código ya no admite más intentos.',
      notCharged: false,
      hint: 'Pide un cobro nuevo al personal.',
    },
  },
  errors: {
    expired: { title: 'Este cobro ha caducado', body: '', notCharged: true, hint: ASK_STAFF_ES },
    notFound: { title: 'Este cobro ya no existe', body: '', notCharged: true, hint: ASK_STAFF_ES },
    inProgress: {
      title: 'Este cobro ya se está procesando',
      body: 'Espera unos segundos antes de volver a mirarlo.',
      notCharged: false,
      retry: 'Comprobar otra vez',
    },
    gateway: {
      title: 'El banco no responde ahora mismo',
      body: 'Suele arreglarse en unos segundos.',
      notCharged: true,
      retry: 'Intentar otra vez',
    },
    generic: {
      title: 'No se ha podido continuar con el cobro',
      body: '',
      notCharged: true,
      retry: 'Intentar otra vez',
      hint: ASK_STAFF_ES,
    },
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
  payPrefix: 'Pay',
  sending: 'Sending…',
  methods: 'Apple Pay · Google Pay · card',
  methodsCard: 'By card',
  methodsWallet: (wallet) => `Opens ${wallet}`,
  payByCard: 'Pay by card',
  tipLegend: 'Add a tip?',
  noTip: 'No tip',
  tipOther: 'Other',
  tipOtherLabel: 'Tip in euros',
  tipMax: (max) => `Up to ${max}`,
  tipToStaff: '100% goes to the staff',
  total: 'Total',
  inAppWarning: (app) =>
    `You are in the ${app} browser. To pay with Apple Pay or Google Pay, open this page in Safari or Chrome: tap ··· and "Open in browser". You can pay by card here.`,
  statement: (name) => `On your statement: "${name}"`,
  expiresIn: 'Expires in',
  openingTitle: 'Opening the payment…',
  openingHint: 'If nothing happens in 2 seconds, tap the button.',
  continueToBank: 'Continue to payment',
  paidTitle: 'Paid',
  alreadyPaidTitle: 'Already paid',
  agoPrefix: '',
  agoSuffix: ' ago',
  notNewPayment: 'This is not a new payment.',
  confirmedAt: (time) => `Confirmed by the bank at ${time}`,
  paidFromBalanceAt: (time) => `Paid from your balance at ${time}`,
  includesTip: (tip) => `Includes a ${tip} tip. Thank you!`,
  codeLabel: 'Code',
  codeHint: 'It must match the one the staff see',
  clockLabel: 'Current time',
  receiptLink: 'View receipt',
  walletReady: 'Your balance is loaded. Open it and save it: it shows your balance and your code to pay.',
  walletOpen: 'See my balance',
  walletElsewhere: "Your balance opens on the phone you paid with. If you can't find it, ask the venue for a new link.",
  walletReadyTitle: 'Your balance is ready',
  unlock: {
    ios: { title: 'Pay with Face ID', button: 'Turn on Face ID', done: 'Face ID is on.' },
    android: {
      title: 'Pay with your fingerprint or screen lock',
      button: 'Turn on fingerprint or lock',
      done: 'Fingerprint or screen lock is on.',
    },
    other: {
      title: 'Pay by unlocking your phone',
      button: 'Turn on unlock',
      done: 'Paying by unlocking your phone is on.',
    },
  },
  unlockWhy:
    'To pay with your balance, you scan the staff QR and unlock your phone. Only someone who can unlock this phone can spend your balance.',
  unlockWaiting: 'Follow the steps on your phone…',
  unlockAfter: 'To pay, scan the staff QR and unlock your phone.',
  unlockUnsupported:
    'This browser cannot pay by unlocking your phone. In your balance you can choose a PIN to pay without your phone.',
  notNow: 'Not now',
  notNowAfter: 'You can turn it on any time from your balance.',
  mergeHint: 'Already have a balance on this phone? Add this top-up to it',
  processingTitle: 'Checking the payment',
  processingBody:
    'We are waiting for the bank to confirm. Do not pay again: this page updates by itself.',
  processingNewCharge:
    'If you closed the bank page without paying, you can try again with the same code in a few minutes.',
  notCharged: 'You have not been charged.',
  notFound: {
    title: 'We cannot find this payment',
    body: 'The link may be incomplete.',
    notCharged: false,
    hint: 'If you have been charged, show the charge in your banking app to the staff.',
  },
  denied: {
    title: 'The bank declined the payment',
    body: 'It happens. Try another card, or Apple Pay or Google Pay.',
    notCharged: true,
    retry: 'Try another method',
  },
  closed: {
    expired: {
      title: 'This payment has expired',
      body: 'Payments expire after a few minutes so nobody can use them later.',
      notCharged: true,
      hint: ASK_STAFF_EN,
    },
    failed: { title: 'This payment did not go through', body: '', notCharged: true, hint: ASK_STAFF_EN },
    canceled: {
      title: 'This payment was cancelled',
      body: '',
      notCharged: true,
      hint: 'If you still need to pay, ask the staff for a new one.',
    },
    unconfirmed: {
      title: 'No confirmation from the bank',
      body: 'We do not know yet whether the bank charged it.',
      notCharged: false,
      hint: 'If you see the charge in your banking app, show it to the staff and they will sort it out.',
    },
    'too-many-attempts': {
      title: 'Too many attempts',
      body: 'This code cannot be used again.',
      notCharged: false,
      hint: 'Ask the staff for a new payment.',
    },
  },
  errors: {
    expired: { title: 'This payment has expired', body: '', notCharged: true, hint: ASK_STAFF_EN },
    notFound: { title: 'This payment no longer exists', body: '', notCharged: true, hint: ASK_STAFF_EN },
    inProgress: {
      title: 'This payment is already being processed',
      body: 'Wait a few seconds before checking again.',
      notCharged: false,
      retry: 'Check again',
    },
    gateway: {
      title: 'The bank is not responding right now',
      body: 'It usually works again in a few seconds.',
      notCharged: true,
      retry: 'Try again',
    },
    generic: {
      title: 'The payment could not continue',
      body: '',
      notCharged: true,
      retry: 'Try again',
      hint: ASK_STAFF_EN,
    },
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
 * detalles internos (ni códigos del banco).
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
