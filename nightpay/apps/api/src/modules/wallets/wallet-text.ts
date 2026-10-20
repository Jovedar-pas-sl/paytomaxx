import { BRAND_NAME } from '../../common/brand';
import type { PayLanguage } from '../payments/pay-i18n';

/**
 * Textos de la página del saldo del cliente (/w/:token). Los de activar el
 * desbloqueo del móvil (Face ID, huella…) son los de pay-i18n (`unlock`).
 * `{amount}` y `{cards}` los rellena el JS.
 */
export interface WalletText {
  htmlLang: PayLanguage;
  locale: string;
  title: string;
  balance: string;
  saveHint: string;
  movements: string;
  movementsHint: string;
  noMovements: string;
  closed: string;
  depleted: string;
  merged: string;
  error: string;
  sending: string;
  cancel: string;
  more: string;
  // Las dos opciones debajo del saldo
  views: string;
  pay: string;
  // «Pagar»: escanear el QR del personal (con el desbloqueo del móvil)
  scanTitle: string;
  scanButton: string;
  /** Sin lector de QR en la página (iPhone): con la cámara del móvil. */
  scanCamera: string;
  scanAim: string;
  scanStop: string;
  /** Un QR que no es un cobro nuestro (/s/… de este dominio). */
  scanWrong: string;
  scanDenied: string;
  scanFailed: string;
  scanOpening: string;
  payFaceWhy: string;
  payFaceDone: string;
  unlockUnsupported: string;
  /** Saldo a cero con la recarga a mano. */
  payEmpty: string;
  // «Pagar» sin móvil: el código y el PIN (o la ficha)
  codeTitle: string;
  codeWithPin: string;
  codeNoPin: string;
  codeFicha: string;
  // Más
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
  mergeDone: string;
  leaveRow: string;
  leaveRowHint: string;
  leaveTitle: string;
  leaveGo: string;
  leaveWaysCards: string;
  leaveWays: string;
  leaveDone: string;
  // Seguimiento de la devolución
  refundTitle: string;
  steps: [string, string, string];
  refundRequested: string;
  refundRequestedCards: string;
  refundApproved: string;
  refundDoneCard: string;
  refundDoneCash: string;
  refundDoneMixed: string;
  // Google Wallet (solo Android y si está configurado; el botón es el oficial)
  gwHint: string;
  gwPreparing: string;
  // «Recargar» desde el móvil (`{amount}`, `{min}` y `{max}` los rellena el JS)
  topUp: string;
  topUpTitle: string;
  topUpWhy: string;
  topUpAmount: string;
  topUpOther: string;
  topUpOtherLabel: string;
  topUpLimits: string;
  topUpRange: string;
  topUpGo: string;
  topUpMethods: string;
  topUpFaceId: string;
  topUpNoKey: string;
  /** Elegir PIN o «Me voy» en un saldo con Face ID, desde un navegador que no puede usarlo. */
  faceIdNeeded: string;
  topUpOpening: string;
  topUpOff: string;
  topUpBlocked: string;
  /** «Pagado» de la recarga al volver del banco. */
  proofWhat: string;
  proofAdded: string;
  other: { code: PayLanguage; label: string };
}

export const WALLET_TEXT: Record<PayLanguage, WalletText> = {
  es: {
    htmlLang: 'es',
    locale: 'es-ES',
    title: `Tu saldo ${BRAND_NAME}`,
    balance: 'Saldo',
    saveHint: 'Guarda esta página (Compartir → Añadir a pantalla de inicio) para volver a tu saldo.',
    movements: 'Movimientos',
    movementsHint: 'Recargas, pagos y devoluciones',
    noMovements: 'Aún no hay movimientos.',
    closed: 'Este saldo ya está cerrado.',
    depleted: 'Has gastado todo el saldo.',
    merged: 'Esta recarga se sumó a tu otro saldo: ábrelo para verlo todo junto.',
    error: 'No se ha podido completar. Inténtalo otra vez.',
    sending: 'Enviando…',
    cancel: 'Cancelar',
    more: 'Más',
    views: '¿Qué quieres hacer?',
    pay: 'Pagar',
    scanTitle: 'Escanea el QR que te enseña el personal',
    scanButton: 'Escanear QR',
    scanCamera: 'Abre la cámara del móvil y apunta al QR del personal.',
    scanAim: 'Apunta al QR del personal.',
    scanStop: 'Cerrar la cámara',
    scanWrong: `Ese QR no es un cobro de ${BRAND_NAME}. Apunta al QR que te enseña el personal.`,
    scanDenied: 'No podemos usar la cámara. Dale permiso, o abre la cámara del móvil y apunta al QR del personal.',
    scanFailed: 'No se ha podido abrir la cámara. Abre la cámara del móvil y apunta al QR del personal.',
    scanOpening: 'Abriendo el cobro…',
    payFaceWhy:
      'Actívalo una vez y paga escaneando el QR del personal y desbloqueando el móvil. Solo quien desbloquee este móvil puede gastar tu saldo.',
    payFaceDone: 'Al pagar, desbloquea el móvil para confirmarlo.',
    unlockUnsupported:
      'Este navegador no permite pagar desbloqueando el móvil. Paga sin él: elige un PIN en «Más» y di tu código al personal.',
    payEmpty: 'No te queda saldo. Recarga para volver a pagar.',
    codeTitle: 'Sin móvil: dile tu código y pon tu PIN',
    codeWithPin: 'Tecleas tu PIN en el móvil del personal.',
    codeNoPin: 'Antes, elige tu PIN en «Más», aquí abajo.',
    codeFicha: 'Con tu ficha: acércala al móvil del personal y pon tu PIN.',
    pinRow: 'Elegir un PIN',
    pinRowHint: 'Para pagar sin sacar el móvil',
    pinTitle: 'Elige un PIN de 4 cifras',
    pinWhy: 'Para pagar sin sacar el móvil: dices tu código ({code}) y tecleas tu PIN en el móvil del personal.',
    pinLabel: 'PIN',
    pinRepeat: 'Repite el PIN',
    pinSave: 'Guardar PIN',
    pinFormat: 'El PIN son 4 cifras.',
    pinMismatch: 'Los dos PIN no son iguales.',
    pinDone: '✓ PIN guardado.',
    mergeRow: 'Juntar saldos',
    mergeRowHint: 'Si ya tenías saldo en este móvil',
    mergeTitle: 'Sumar a tu otro saldo',
    mergeWhy:
      'Si ya tenías saldo en este móvil, súmale esta recarga: lo verás todo junto en tu otro saldo y esta página se quedará a 0.',
    mergeButton: 'Sumar a mi otro saldo',
    mergeDone: '✓ Sumado. Tu otro saldo tiene ahora {amount}.',
    leaveRow: 'Me voy: devolver mi saldo',
    leaveRowHint: 'Te devolvemos lo que te queda',
    leaveTitle: '¿Te devolvemos {amount}?',
    leaveGo: 'Pedir la devolución',
    leaveWaysCards: 'A tu tarjeta {cards} o en efectivo en el local. Lo hace el encargado.',
    leaveWays: 'A tu tarjeta o en efectivo en el local. Lo hace el encargado.',
    leaveDone: '✓ Pedido. Pasa por la barra o espera al encargado.',
    refundTitle: 'Devolución de {amount}',
    steps: ['Pedido', 'Aprobado', 'Devuelto'],
    refundRequested: 'Pasa por la barra o espera al encargado: te lo devuelve a tu tarjeta o en efectivo.',
    refundRequestedCards: 'Pasa por la barra o espera al encargado: te lo devuelve a tu tarjeta {cards} o en efectivo.',
    refundApproved: 'A tu tarjeta {cards}. El banco puede tardar unos días en enseñarlo.',
    refundDoneCard: 'Devuelto a tu tarjeta {cards}. El banco puede tardar unos días en enseñarlo.',
    refundDoneCash: 'Devuelto en efectivo.',
    refundDoneMixed: 'Devuelto: parte a tu tarjeta {cards} y parte en efectivo.',
    gwHint: 'Lleva tu saldo en Google Wallet: se actualiza solo.',
    gwPreparing: 'Preparando tu pase…',
    topUp: 'Recargar',
    topUpTitle: 'Recargar saldo',
    topUpWhy: 'Elige cuánto. Pagas con Apple Pay, Google Pay o tarjeta y se suma a tu saldo al momento.',
    topUpAmount: 'Importe',
    topUpOther: 'Otra',
    topUpOtherLabel: 'Importe en euros',
    topUpLimits: 'De {min} a {max}.',
    topUpRange: 'Pon un importe de {min} a {max}, en euros enteros.',
    topUpGo: 'Recargar {amount}',
    topUpMethods: 'Sin propina: solo pagas lo que recargas.',
    topUpFaceId: 'Para confirmarlo, desbloquea tu móvil como al pagar.',
    topUpNoKey: 'Este saldo tiene Face ID: recarga desde el móvil donde lo activaste.',
    faceIdNeeded: 'Este saldo tiene Face ID: hazlo desde el móvil donde lo activaste.',
    topUpOpening: 'Abriendo el pago…',
    topUpOff: 'Ahora no se puede recargar desde el móvil. Pide la recarga en el local.',
    topUpBlocked: 'Este saldo está bloqueado. Pregunta en el local.',
    proofWhat: 'Recarga de {amount}',
    proofAdded: 'Ya está en tu saldo.',
    other: { code: 'en', label: 'English' },
  },
  en: {
    htmlLang: 'en',
    locale: 'en-GB',
    title: `Your ${BRAND_NAME} balance`,
    balance: 'Balance',
    saveHint: 'Save this page (Share → Add to Home Screen) to come back to your balance.',
    movements: 'Activity',
    movementsHint: 'Top-ups, payments and refunds',
    noMovements: 'No activity yet.',
    closed: 'This balance is closed.',
    depleted: 'You have spent all your balance.',
    merged: 'This top-up was added to your other balance: open it to see everything together.',
    error: 'That did not work. Please try again.',
    sending: 'Sending…',
    cancel: 'Cancel',
    more: 'More',
    views: 'What do you want to do?',
    pay: 'Pay',
    scanTitle: 'Scan the QR the staff show you',
    scanButton: 'Scan QR',
    scanCamera: 'Open your phone camera and point it at the staff QR.',
    scanAim: 'Point at the staff QR.',
    scanStop: 'Close the camera',
    scanWrong: `That QR is not a charge from ${BRAND_NAME}. Point at the QR the staff show you.`,
    scanDenied: 'We cannot use the camera. Allow it, or open your phone camera and point it at the staff QR.',
    scanFailed: 'The camera did not open. Open your phone camera and point it at the staff QR.',
    scanOpening: 'Opening the charge…',
    payFaceWhy:
      'Turn it on once, then pay by scanning the staff QR and unlocking your phone. Only someone who can unlock this phone can spend your balance.',
    payFaceDone: 'When you pay, unlock your phone to confirm.',
    unlockUnsupported:
      'This browser cannot pay by unlocking your phone. Pay without it: choose a PIN under "More" and tell the staff your code.',
    payEmpty: 'You have no balance left. Top up to pay again.',
    codeTitle: 'No phone? Tell the staff your code and enter your PIN',
    codeWithPin: 'You type your PIN on the staff phone.',
    codeNoPin: 'First, choose your PIN under "More" below.',
    codeFicha: 'With your tag: hold it to the staff phone and enter your PIN.',
    pinRow: 'Choose a PIN',
    pinRowHint: 'To pay without your phone',
    pinTitle: 'Choose a 4-digit PIN',
    pinWhy: 'To pay without your phone: say your code ({code}) and type your PIN on the staff phone.',
    pinLabel: 'PIN',
    pinRepeat: 'Repeat PIN',
    pinSave: 'Save PIN',
    pinFormat: 'The PIN is 4 digits.',
    pinMismatch: 'The two PINs do not match.',
    pinDone: '✓ PIN saved.',
    mergeRow: 'Combine balances',
    mergeRowHint: 'If you already had a balance on this phone',
    mergeTitle: 'Add to your other balance',
    mergeWhy:
      'If you already had a balance on this phone, add this top-up to it: you will see everything together there and this page will go to 0.',
    mergeButton: 'Add to my other balance',
    mergeDone: '✓ Added. Your other balance now has {amount}.',
    leaveRow: "I'm leaving: refund my balance",
    leaveRowHint: 'We refund what you have left',
    leaveTitle: 'Refund {amount}?',
    leaveGo: 'Ask for the refund',
    leaveWaysCards: 'To your card {cards} or in cash at the venue. The manager does it.',
    leaveWays: 'To your card or in cash at the venue. The manager does it.',
    leaveDone: '✓ Requested. Go to the bar or wait for the manager.',
    refundTitle: 'Refund of {amount}',
    steps: ['Requested', 'Approved', 'Refunded'],
    refundRequested: 'Go to the bar or wait for the manager: they refund it to your card or in cash.',
    refundRequestedCards: 'Go to the bar or wait for the manager: they refund it to your card {cards} or in cash.',
    refundApproved: 'To your card {cards}. Your bank may take a few days to show it.',
    refundDoneCard: 'Refunded to your card {cards}. Your bank may take a few days to show it.',
    refundDoneCash: 'Refunded in cash.',
    refundDoneMixed: 'Refunded: part to your card {cards} and part in cash.',
    gwHint: 'Keep your balance in Google Wallet: it updates itself.',
    gwPreparing: 'Preparing your pass…',
    topUp: 'Top up',
    topUpTitle: 'Top up your balance',
    topUpWhy: 'Choose how much. Pay with Apple Pay, Google Pay or card and it is added to your balance straight away.',
    topUpAmount: 'Amount',
    topUpOther: 'Other',
    topUpOtherLabel: 'Amount in euros',
    topUpLimits: 'From {min} to {max}.',
    topUpRange: 'Enter an amount from {min} to {max}, in whole euros.',
    topUpGo: 'Top up {amount}',
    topUpMethods: 'No tip: you only pay what you top up.',
    topUpFaceId: 'To confirm, unlock your phone as when you pay.',
    topUpNoKey: 'This balance uses Face ID: top up from the phone where you turned it on.',
    faceIdNeeded: 'This balance uses Face ID: do this from the phone where you turned it on.',
    topUpOpening: 'Opening the payment…',
    topUpOff: 'Topping up from your phone is not available right now. Ask the staff to top up.',
    topUpBlocked: 'This balance is blocked. Ask at the venue.',
    proofWhat: 'Top-up of {amount}',
    proofAdded: 'It is already in your balance.',
    other: { code: 'es', label: 'Español' },
  },
};
