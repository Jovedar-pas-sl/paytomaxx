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
  codeTitle: string;
  codeHint: string;
  saveHint: string;
  movements: string;
  noMovements: string;
  closed: string;
  depleted: string;
  merged: string;
  error: string;
  sending: string;
  cancel: string;
  more: string;
  // Paso principal: activar el desbloqueo
  unlockUnsupported: string;
  // Secundarias
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
  other: { code: PayLanguage; label: string };
}

export const WALLET_TEXT: Record<PayLanguage, WalletText> = {
  es: {
    htmlLang: 'es',
    locale: 'es-ES',
    title: `Tu saldo ${BRAND_NAME}`,
    balance: 'Saldo',
    codeTitle: 'Tu código',
    codeHint: 'Por si te lo pide el encargado, o para pagar con tu PIN sin sacar el móvil.',
    saveHint: 'Guarda esta página (Compartir → Añadir a pantalla de inicio) para volver a tu saldo.',
    movements: 'Movimientos',
    noMovements: 'Aún no hay movimientos.',
    closed: 'Este saldo ya está cerrado.',
    depleted: 'Has gastado todo el saldo.',
    merged: 'Esta recarga se sumó a tu otro saldo: ábrelo para verlo todo junto.',
    error: 'No se ha podido completar. Inténtalo otra vez.',
    sending: 'Enviando…',
    cancel: 'Cancelar',
    more: 'Más opciones',
    unlockUnsupported:
      'Este navegador no permite pagar desbloqueando el móvil. Elige un PIN y paga sin sacarlo: dices tu código y tecleas tu PIN.',
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
    mergeRow: 'Sumar a mi otro saldo',
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
    other: { code: 'en', label: 'English' },
  },
  en: {
    htmlLang: 'en',
    locale: 'en-GB',
    title: `Your ${BRAND_NAME} balance`,
    balance: 'Balance',
    codeTitle: 'Your code',
    codeHint: 'In case the manager asks for it, or to pay with your PIN without your phone.',
    saveHint: 'Save this page (Share → Add to Home Screen) to come back to your balance.',
    movements: 'Activity',
    noMovements: 'No activity yet.',
    closed: 'This balance is closed.',
    depleted: 'You have spent all your balance.',
    merged: 'This top-up was added to your other balance: open it to see everything together.',
    error: 'That did not work. Please try again.',
    sending: 'Sending…',
    cancel: 'Cancel',
    more: 'More options',
    unlockUnsupported:
      'This browser cannot pay by unlocking your phone. Choose a PIN and pay without your phone: say your code and type your PIN.',
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
    mergeRow: 'Add to my other balance',
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
    other: { code: 'es', label: 'Español' },
  },
};
