import type { PayLanguage } from '../customer-lang';
import type { PayClosedReason } from '../pay-redirect';

/**
 * Lo que lee el cliente en sus páginas (/pay, /s, /w, /w/card, /w/salida y
 * sus avisos), en los cuatro idiomas: cada idioma en su archivo (es.ts,
 * en.ts, fr.ts, pt.ts), con la misma forma. i18n.spec.ts falla si falta una
 * clave en algún idioma, si queda vacía, si cambia un {hueco} o si se cuela
 * el vocabulario interno de la app del personal.
 *
 * Reglas de redacción: frases cortas de app de pagos, de usted en francés y
 * portugués (de Portugal, con palabras que entiende también un brasileño:
 * «telefone», «funcionário», «gorjeta», «recibo»…); «Apple Pay», «Google
 * Pay», «Face ID» y «Google Wallet» nunca se traducen (normas de las marcas).
 */

/** La página «Pagar con bitcoin»: el QR, los importes y los estados. */
export interface BitcoinText {
  title: string;
  /** Debajo del QR. */
  scan: string;
  /** «En bitcoin»: el importe en BTC. */
  inBtc: string;
  /** «1 BTC = 64.000 €». */
  rate: (rate: string) => string;
  openWallet: string;
  copyAddress: string;
  copied: string;
  /** Enlace a la página de pago completa de la tienda. */
  fullPage: string;
  timeLeft: string;
  waiting: string;
  /** El pago ya llegó y se está confirmando. */
  confirming: string;
  /** La factura caducó: no se ha cobrado nada. */
  expiredTitle: string;
  expiredBody: string;
  /** Pago a medias o tardío: lo ve el personal. */
  problemTitle: string;
  problemBody: string;
  /** Volver a elegir cómo pagar. */
  other: string;
  /** Con el QR a la vista: cerrar la factura y volver a las demás formas de pago. */
  payOtherWay: string;
  /** Sin red. */
  offline: string;
  /** Texto que lee el lector de pantalla del QR. */
  qrAlt: string;
}

export type PayErrorKey =
  | 'expired'
  | 'notFound'
  | 'inProgress'
  | 'gateway'
  | 'gatewayFailed'
  | 'gatewayFailedAfterAttempt'
  | 'generic';

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

/** «Comprobando el pago» (pay-checking-page.ts): cada fase de la espera del banco. */
export interface CheckingText {
  /** 0–20 s. */
  start: string;
  /** Desde los 8 s. */
  startBody: string;
  /** Los tres pasos: enviado, el banco lo confirma, pagado. */
  steps: readonly [string, string, string];
  /** 20–60 s. */
  slow: string;
  slowBody: string;
  /** 60 s–2:30. */
  still: string;
  /** «Podrás intentarlo otra vez en 1:27.» */
  retryIn: (time: string) => string;
  /** Pasados 2:30 sin respuesta (y el QR vigente). */
  noAnswer: string;
  noAnswerBody: string;
  retry: string;
  bankAppTitle: string;
  /** «Busca «SALA AURORA» de 38,30 €: enséñaselo al camarero.» */
  bankApp: (name: string, amount: string) => string;
  bankAppNoName: (amount: string) => string;
  /** Sin confirmación del banco: se sigue comprobando sola. */
  unconfirmed: string;
  unconfirmedBody: string;
  /** Pasados 30 min ya no se comprueba sola. */
  unconfirmedStopped: string;
  offline: string;
  otherPayer: string;
  showStaff: string;
  /** «Enviado a tu banco a las 23:41». */
  sentAt: (time: string) => string;
  reference: string;
  amount: string;
  plateHint: string;
  close: string;
}

export interface PayText {
  htmlLang: PayLanguage;
  locale: string;
  secure: string;
  /** El selector de idioma (su etiqueta para lectores de pantalla). */
  languageMenu: string;
  // Página de pago
  youPay: string;
  /** Encima del importe grande: lo que paga ahora (se pone al día con la propina). */
  totalToPay: string;
  payPrefix: string;
  sending: string;
  /** Mientras se abre el pago: «Abriendo Apple Pay…» / «Abriendo el pago…». */
  openingWallet: (wallet: string) => string;
  methods: string;
  methodsCard: string;
  /** El botón abre directamente la cartera del móvil (Apple Pay / Google Pay). */
  methodsWallet: (wallet: string) => string;
  payByCard: string;
  /** Entre la cartera y la tarjeta: «o». */
  or: string;
  /** Cobro único: pagar el mismo cobro con el saldo (Face ID), en otra página. */
  payWithSaldo: string;
  /** «Pagar con bitcoin» (BTCPay): el botón de la página de pago, si el local lo tiene encendido. */
  payWithBitcoin: string;
  /** «Pagar con» del botón de bitcoin al estilo de Apple Pay: va delante del logo y de «bitcoin». */
  payWithBitcoinPrefix: string;
  /** La línea corta debajo de «Pagar con bitcoin»: cuánto tarda cada forma. */
  bitcoinHint: string;
  bitcoin: BitcoinText;
  tipLegend: string;
  noTip: string;
  tipOther: string;
  tipOtherLabel: string;
  tipMax: (max: string) => string;
  /** «Otra» elegida y sin importe. */
  tipOtherEmpty: string;
  /** «Otra» por encima del tope. */
  tipOtherTooHigh: (max: string) => string;
  tipToStaff: string;
  total: string;
  /** Desglose: Consumo (o Recarga) · Comisión del servicio · Propina · Total. */
  breakdown: { consumption: string; topUp: string; serviceFee: string; tip: string };
  /** «¿Qué es?» junto a la comisión del servicio. */
  feeWhat: string;
  /** Su explicación corta; `pct` = «10 %». */
  feeExplain: (pct: string) => string;
  /** Cobro único: con el saldo no se paga la comisión del servicio. */
  saldoNoFee: string;
  inAppWarning: (app: string) => string;
  statement: (name: string) => string;
  /** Quién cobra (su nombre visible): «Te cobra Ana». */
  chargedBy: (name: string) => string;
  /** A nombre de una compañera (cobro por el encargado): «Servicio con Nerea». */
  serviceWith: (name: string) => string;
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
  /** Unidades de «hace 23 min», «hace 1 h 05 min», «hace 2 d». */
  agoUnits: { min: string; h: string; d: string };
  notNewPayment: string;
  /** A los 5 min el «Pagado» se cierra: solo esta frase y el justificante. */
  paidClosed: string;
  confirmedAt: (time: string) => string;
  paidFromBalanceAt: (time: string) => string;
  /** «¡Gracias por la propina!» (en el PAGADO, si dejó). */
  thanksTip: string;
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
  /** «Comprobando el pago» con su estado en vivo (05-ui-ux §4.4). */
  checking: CheckingText;
  // Muchos a la vez en la misma IP (wifi del local): la página espera y se recarga sola
  busyTitle: string;
  busyBody: string;
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
    /** Una recarga del saldo: el importe es «Recarga». */
    topUp: string;
    serviceFee: string;
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

/**
 * Página del saldo del cliente (/w/:token). Los de activar el desbloqueo del
 * móvil (Face ID, huella…) son los de PayText (`unlock`). `{amount}`,
 * `{cards}`… los rellena el JS.
 */
export interface WalletText {
  htmlLang: PayLanguage;
  locale: string;
  title: string;
  balance: string;
  /** «Tu saldo · {venue}» en la tarjeta de arriba. */
  balanceOf: string;
  /** «Ficha nº {n}» en la tarjeta de arriba. */
  fichaNo: string;
  saveHint: string;
  movements: string;
  movementsHint: string;
  noMovements: string;
  /** Movimientos que pone el API (los consumos llevan lo que se pidió, tal cual). */
  mv: { topUp: string; topUpCash: string; topUpCashVoid: string; payoutCash: string; payoutCard: string };
  closed: string;
  depleted: string;
  merged: string;
  error: string;
  sending: string;
  cancel: string;
  more: string;
  views: string;
  pay: string;
  scanTitle: string;
  scanButton: string;
  scanCamera: string;
  scanAim: string;
  scanStop: string;
  scanWrong: string;
  scanDenied: string;
  scanFailed: string;
  scanOpening: string;
  payFaceWhy: string;
  payFaceDone: string;
  unlockUnsupported: string;
  payEmpty: string;
  codeTitle: string;
  codeWithPin: string;
  codeNoPin: string;
  codeFicha: string;
  pinRow: string;
  pinRowHint: string;
  pinTitle: string;
  pinWhy: string;
  pinLabel: string;
  pinRepeat: string;
  pinSave: string;
  pinFormat: string;
  pinMismatch: string;
  pinDone: string;
  mergeRow: string;
  mergeRowHint: string;
  mergeTitle: string;
  mergeWhy: string;
  mergeButton: string;
  /** «Juntar saldos» sin ser el móvil que pagó: el PIN de esta recarga. */
  mergePinLabel: string;
  mergeDone: string;
  /**
   * La regla del saldo (decisión del dueño, 17-nov-2026): no se devuelve, se
   * queda para la próxima visita. En «Más» (donde estaba «Me voy») y antes de
   * cargar (debajo del botón de «Recargar»).
   */
  keepRule: string;
  /** Una devolución del saldo pedida antes del cambio y aún en curso: su título, pasos y cómo va. */
  refundTitle: string;
  steps: [string, string, string];
  refundRequested: string;
  refundRequestedCards: string;
  refundApproved: string;
  refundDoneCard: string;
  refundDoneCash: string;
  refundDoneMixed: string;
  gwHint: string;
  gwPreparing: string;
  topUp: string;
  topUpTitle: string;
  /** La línea de «Recargar»: elige cuánto, paga (Apple Pay, Google Pay o tarjeta, sin propina) y el saldo sube al momento. */
  topUpWhy: string;
  topUpAmount: string;
  topUpOther: string;
  topUpOtherLabel: string;
  topUpLimits: string;
  topUpRange: string;
  topUpGo: string;
  /** Con la «Comisión del servicio»: el botón dice lo que paga, el total («Pagar 56 €»). */
  topUpGoFee: string;
  /** Con la «Comisión del servicio»: el desglose (Recarga · Comisión · Total a pagar). */
  topUpToBalance: string;
  /** «¿Qué es?» de la comisión en una recarga (el de PayText habla del consumo); `{pct}` = «12 %». */
  topUpFeeExplain: string;
  topUpFaceId: string;
  topUpNoKey: string;
  faceIdNeeded: string;
  topUpOpening: string;
  topUpOff: string;
  topUpBlocked: string;
  proofWhat: string;
  proofAdded: string;
  lostButton: string;
  lostTitle: string;
  lostWhy: string;
  lostSafe: string;
  lostGo: string;
  lostKeep: string;
  /** Con ficha y sin Face ID no hay botón de bloquear: qué hacer si la pierde. */
  lostAsk: string;
  lostDone: string;
  /** «Al momento»: la franja cuando la página no consigue ponerse al día (M-7). */
  reconnecting: string;
  /** El enlace ya no vale (el dueño dio otro): la página deja de preguntar. */
  linkGone: string;
  /** Sin Face ID ni PIN y sin poder activarlo aquí (M-2): el QR de activación de recepción. */
  activateAtReception: string;
  /** «Detalle del pago»: al tocar un movimiento (lo pagado con el saldo y las recargas con tarjeta). */
  detail: WalletDetailText;
}

/**
 * La hoja del detalle de un pago en /w: qué, cuándo, dónde, quién le cobró
 * (su nombre de pila), cómo pagó, el código y el saldo antes y después. Las
 * palabras únicas: «Pagado», «Devuelto» para lo que vuelve, «Cancelado» solo
 * para lo que no se pagó.
 */
export interface WalletDetailText {
  title: string;
  loading: string;
  failed: string;
  close: string;
  amount: string;
  tip: string;
  fee: string;
  total: string;
  when: string;
  where: string;
  /** «Te cobró: Ana». */
  who: string;
  how: string;
  code: string;
  before: string;
  after: string;
  /** «Tarjeta Visa ••4242». */
  card: string;
  saldo: string;
  /** «Tu ficha nº 0522». */
  ficha: string;
  paid: string;
  refunded: string;
  partlyRefunded: string;
  /** Un pago con el saldo que el local deshizo: el dinero volvió al saldo (también la marca de la fila). */
  returned: string;
  canceled: string;
  pending: string;
  undoCard: string;
  undoSaldo: string;
}

/** /w/a/<token>: el QR de activación de un solo uso (el primer Face ID o el primer PIN, M-2). */
export interface ActivationText {
  title: string;
  heading: string;
  intro: string;
  /** «Prefiero un PIN» (o el único camino si el móvil no puede activar el desbloqueo). */
  pinOffer: string;
  pinWhy: string;
  done: string;
  /** El QR de recepción de un saldo con PIN: lo teclea antes de activar. */
  pinAsk: string;
  /** Activó Face ID y el saldo ya tenía un PIN: por si no lo eligió él. */
  hadPin: string;
  go: string;
  usedHeading: string;
  used: string;
  expiredHeading: string;
  expired: string;
  unsupported: string;
  cancelled: string;
}

/** /s/:token: pagar el cobro del QR del personal con el saldo (Face ID). */
export interface SaldoText {
  title: string;
  youPay: string;
  pay: string;
  paying: string;
  /** «Te quedan 38 €» debajo del PAGADO (`{amount}`). */
  left: string;
  expired: string;
  notPending: string;
  /** Cobro único: ya lo pagó con tarjeta. */
  paidByCard: string;
  notFromBalance: string;
  askStaff: string;
  unsupported: string;
  unknown: string;
  /** Mientras pregunta al servidor si se cobró. */
  checking: string;
  /** El servidor dice que sigue pendiente: se puede volver a pagar. */
  stillPending: string;
  reload: string;
  expiresIn: string;
}

/** Antes de desbloquear el saldo (/w/card/<ficha> y el enlace privado con Face ID sin sesión). */
export interface UnlockPageText {
  title: string;
  card: string;
  heading: string;
  intro: string;
  button: string;
  waiting: string;
  security: string;
  newPhone: string;
  setupHeading: string;
  setup: string;
  setupWhere: string;
  setupHow: string;
  setupFoot: string;
  blockedHeading: string;
  blocked: string;
  unavailableHeading: string;
  unavailableText: string;
  code: string;
  unsupported: string;
  cancelled: string;
  wrong: string;
  expired: string;
  unavailable: string;
  rateLimited: string;
  error: string;
  /** B7: «Recargar esta ficha» y «Ver mi saldo con mi PIN». */
  ficha: FichaCardText;
}

/**
 * La ficha en el móvil del cliente (estudio de fichas, B7): recargarla (solo
 * suma) y ver el saldo con el PIN (10 min, sin pagos). `{amount}`, `{min}`,
 * `{max}` y `{time}` los rellena la página.
 */
export interface FichaCardText {
  topUpTitle: string;
  topUpWhy: string;
  topUpOther: string;
  topUpOtherLabel: string;
  topUpLimits: string;
  topUpGo: string;
  topUpFee: string;
  topUpOpening: string;
  topUpLimit: string;
  topUpOff: string;
  topUpAmount: string;
  pinTitle: string;
  pinWhy: string;
  pinLabel: string;
  pinGo: string;
  pinBalance: string;
  pinUntil: string;
  pinAgain: string;
  pinExpired: string;
  pinFormat: string;
  pinWrong: string;
  pinLocked: string;
  rateLimited: string;
  error: string;
}

/**
 * Errores del API que ve el cliente, por su `code` (nunca el texto del API).
 * `TOPUP_<motivo>`: el 409 WALLET_TOPUP_UNAVAILABLE con su `reason`.
 */
export const CLIENT_ERROR_KEYS = [
  'generic',
  'network',
  'RATE_LIMITED',
  'TRY_LATER',
  'VENUE_PAUSED',
  'PAYMENT_METHOD_DISABLED',
  'WALLET_NOT_FOUND',
  'WALLET_BLOCKED',
  'WALLET_CLOSED',
  'WALLET_VIEW_REQUIRED',
  'WALLET_INSUFFICIENT',
  // El saldo no se devuelve (17-nov-2026): lo que antes era «Me voy» o la salida de recepción.
  'SALDO_NO_SE_DEVUELVE',
  'WALLET_TOPUP_TOO_MANY',
  'WALLET_TOPUP_DAILY_LIMIT',
  'WALLET_TOPUP_PENDING_LIMIT',
  'WALLET_TOPUP_AMOUNT',
  'WALLET_TOPUP_STALE',
  'PAGE_STALE',
  'TOPUP_blocked',
  'TOPUP_merged',
  'TOPUP_closed',
  'TOPUP_leaving',
  'TOPUP_venue',
  'FACE_ID_REQUIRED',
  'FACE_ID_WRONG',
  'FACE_ID_UNKNOWN',
  'FACE_ID_TIMEOUT',
  'FACE_ID_FAILED',
  'FACE_ID_USED',
  'FACE_ID_EXISTS',
  'FACE_ID_NOT_SET',
  'WALLET_NO_CARD',
  'PIN_FORMAT',
  'PIN_MISMATCH',
  'PIN_OBVIOUS',
  'PIN_EXISTS',
  'PIN_WRONG',
  'PIN_LOCKED',
  'MERGE_PROOF_REQUIRED',
  'PAYER_ONLY',
  'MERGE_BUSY',
  'MERGE_NOT_ALLOWED',
  'CHARGE_NOT_PENDING',
  'CHARGE_EXPIRED',
  'CHARGE_OTHER_VENUE',
  'ALREADY_PAID',
  'ACTIVATION_USED',
  'ACTIVATION_EXPIRED',
  'ACTIVATION_REQUIRED',
  // B7: la ficha en el móvil del cliente («Ver mi saldo con mi PIN»).
  'CARD_NO_PIN',
  'CARD_VIEW_EXPIRED',
  'CARD_VIEW_LOCKED',
] as const;

export type ClientErrorKey = (typeof CLIENT_ERROR_KEYS)[number];
export type ClientErrorTexts = Readonly<Record<ClientErrorKey, string>>;

/** Todo lo de un idioma. */
export interface CustomerTexts {
  pay: PayText;
  wallet: WalletText;
  saldo: SaldoText;
  unlockPage: UnlockPageText;
  activation: ActivationText;
  errors: ClientErrorTexts;
}
