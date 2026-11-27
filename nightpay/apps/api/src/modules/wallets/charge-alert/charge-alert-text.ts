import type { PayLanguage } from '../../payments/pay-i18n';

/**
 * Textos de «Aviso en cada cobro»: el aviso que llega al móvil, la fila de la
 * página del saldo y la página «No he sido yo». Español sencillo primero; las
 * demás lenguas, las de la página del saldo.
 */
export interface ChargeAlertText {
  locale: string;
  /** El aviso: «Se han cobrado 12 €». */
  pushTitle: string;
  /** «En Sala Aurora · te quedan 38 €». */
  pushBody: string;
  /** Sin nombre del local (no debería pasar): «Te quedan 38 €». */
  pushBodyNoVenue: string;
  pushNotMe: string;
  /** Una carga de otra plataforma anulada (API de socios): «Carga anulada · Cajeros». */
  loadVoidTitle: string;
  /** «Se han quitado 20 € de tu saldo · te quedan 30 €». */
  loadVoidBody: string;
  // Página del saldo («Más»).
  row: string;
  rowOff: string;
  rowOn: string;
  rowIos: string;
  rowNeedKey: string;
  needKeyTitle: string;
  needKeyText: string;
  confirmTitle: string;
  confirmText: string;
  confirmGo: string;
  close: string;
  on: string;
  off: string;
  denied: string;
  unsupported: string;
  failed: string;
  iosTitle: string;
  iosSteps: readonly string[];
  iosNote: string;
  iosClose: string;
  // Página «No he sido yo».
  pageTitle: string;
  question: string;
  /** «en Sala Aurora». */
  atVenue: string;
  when: string;
  explain: string;
  keep: string;
  go: string;
  goBusy: string;
  ifYou: string;
  doneTitle: string;
  doneText: string;
  doneNoCard: string;
  alreadyTitle: string;
  alreadyText: string;
  expiredTitle: string;
  expiredText: string;
  invalidTitle: string;
  invalidText: string;
  notPaidText: string;
}

export const CHARGE_ALERT_TEXT: Readonly<Record<PayLanguage, ChargeAlertText>> = Object.freeze({
  es: {
    locale: 'es-ES',
    pushTitle: 'Se han cobrado {amount}',
    pushBody: 'En {venue} · te quedan {balance}',
    pushBodyNoVenue: 'Te quedan {balance}',
    pushNotMe: 'No he sido yo',
    loadVoidTitle: 'Carga anulada · {partner}',
    loadVoidBody: 'Se han quitado {amount} de tu saldo · te quedan {balance}',
    row: 'Avisarme de cada cobro',
    rowOff: 'Te llega un aviso al móvil cada vez que se paga con tu saldo.',
    rowOn: 'Activado en este móvil. Toca para quitarlo.',
    rowIos: 'En iPhone, primero añade esta página a tu pantalla de inicio.',
    rowNeedKey: 'Primero activa Face ID o huella en este saldo.',
    needKeyTitle: 'Primero, Face ID o huella',
    needKeyText: 'Para activar el aviso hace falta el Face ID o la huella de este saldo: así solo te apuntas tú. Pide en recepción el QR de activación.',
    confirmTitle: 'Confirma que eres tú',
    confirmText: 'Con tu Face ID o tu huella activamos el aviso en este móvil.',
    confirmGo: 'Activar con Face ID',
    close: 'Cerrar',
    on: 'Listo: te avisaremos de cada cobro.',
    off: 'Hecho: ya no te avisaremos en este móvil.',
    denied: 'Has bloqueado los avisos de esta página. Actívalos en los ajustes del navegador.',
    unsupported: 'Este navegador no puede recibir avisos.',
    failed: 'No se ha podido activar. Prueba otra vez.',
    iosTitle: 'Avisos en iPhone',
    iosSteps: [
      'Toca Compartir (el cuadrado con la flecha hacia arriba).',
      'Elige «Añadir a pantalla de inicio».',
      'Abre tu saldo desde el icono nuevo y toca «Avisarme de cada cobro».',
    ],
    iosNote: 'Hace falta iOS 16.4 o más nuevo.',
    iosClose: 'Entendido',
    pageTitle: '¿Has sido tú?',
    question: '¿Has sido tú?',
    atVenue: 'en {venue}',
    when: 'Cobro {ref} · {when}',
    explain:
      'Si no has sido tú, bloqueamos tu ficha y tu PIN para que nadie más pague con ellos. Tu saldo sigue siendo tuyo. Avisamos a recepción para que revise el cobro y, si procede, te lo devuelva.',
    keep: 'Con tu Face ID puedes seguir pagando.',
    go: 'No he sido yo',
    goBusy: 'Bloqueando…',
    ifYou: 'Si has sido tú, no tienes que hacer nada.',
    doneTitle: 'Ficha y PIN bloqueados',
    doneText: 'Hemos avisado a recepción del cobro {ref}. Pasa por recepción: lo revisan contigo y te dan una ficha nueva.',
    doneNoCard: 'Hemos avisado a recepción del cobro {ref}. Pasa por recepción para revisarlo contigo.',
    alreadyTitle: 'Ya nos lo has dicho',
    alreadyText: 'Recepción ya está revisando este cobro.',
    expiredTitle: 'Este enlace ha caducado',
    expiredText: 'Si no reconoces un cobro, ve a recepción.',
    invalidTitle: 'Este enlace no vale',
    invalidText: 'Si no reconoces un cobro, ve a recepción.',
    notPaidText: 'Este cobro no se llegó a pagar con tu saldo.',
  },
  en: {
    locale: 'en-GB',
    pushTitle: '{amount} charged',
    pushBody: 'At {venue} · {balance} left',
    pushBodyNoVenue: '{balance} left',
    pushNotMe: 'It wasn’t me',
    loadVoidTitle: 'Top-up cancelled · {partner}',
    loadVoidBody: '{amount} taken off your balance · {balance} left',
    row: 'Notify me of every charge',
    rowOff: 'Get a notification on your phone every time your balance is used.',
    rowOn: 'On for this phone. Tap to turn it off.',
    rowIos: 'On iPhone, first add this page to your Home Screen.',
    rowNeedKey: 'First turn on Face ID or fingerprint for this balance.',
    needKeyTitle: 'First, Face ID or fingerprint',
    needKeyText: 'To turn on notifications you need this balance’s Face ID or fingerprint, so only you can sign up. Ask reception for the activation QR.',
    confirmTitle: 'Confirm it’s you',
    confirmText: 'We turn on notifications on this phone with your Face ID or fingerprint.',
    confirmGo: 'Turn on with Face ID',
    close: 'Close',
    on: 'Done: we’ll notify you of every charge.',
    off: 'Done: no more notifications on this phone.',
    denied: 'You’ve blocked notifications for this page. Turn them on in your browser settings.',
    unsupported: 'This browser can’t receive notifications.',
    failed: 'Couldn’t turn it on. Please try again.',
    iosTitle: 'Notifications on iPhone',
    iosSteps: [
      'Tap Share (the square with the arrow pointing up).',
      'Choose “Add to Home Screen”.',
      'Open your balance from the new icon and tap “Notify me of every charge”.',
    ],
    iosNote: 'You need iOS 16.4 or newer.',
    iosClose: 'Got it',
    pageTitle: 'Was it you?',
    question: 'Was it you?',
    atVenue: 'at {venue}',
    when: 'Charge {ref} · {when}',
    explain:
      'If it wasn’t you, we block your card and your PIN so nobody else can pay with them. Your balance is still yours. We tell reception so they can check the charge and refund it if appropriate.',
    keep: 'You can keep paying with your Face ID.',
    go: 'It wasn’t me',
    goBusy: 'Blocking…',
    ifYou: 'If it was you, you don’t need to do anything.',
    doneTitle: 'Card and PIN blocked',
    doneText: 'We’ve told reception about charge {ref}. Go to reception: they’ll check it with you and give you a new card.',
    doneNoCard: 'We’ve told reception about charge {ref}. Go to reception to check it with you.',
    alreadyTitle: 'You’ve already told us',
    alreadyText: 'Reception is already checking this charge.',
    expiredTitle: 'This link has expired',
    expiredText: 'If you don’t recognise a charge, go to reception.',
    invalidTitle: 'This link isn’t valid',
    invalidText: 'If you don’t recognise a charge, go to reception.',
    notPaidText: 'This charge was never paid with your balance.',
  },
  fr: {
    locale: 'fr-FR',
    pushTitle: '{amount} débités',
    pushBody: 'À {venue} · il vous reste {balance}',
    pushBodyNoVenue: 'Il vous reste {balance}',
    pushNotMe: 'Ce n’est pas moi',
    loadVoidTitle: 'Recharge annulée · {partner}',
    loadVoidBody: '{amount} retirés de votre solde · il vous reste {balance}',
    row: 'M’avertir de chaque paiement',
    rowOff: 'Recevez une notification sur votre téléphone à chaque paiement avec votre solde.',
    rowOn: 'Activé sur ce téléphone. Touchez pour le retirer.',
    rowIos: 'Sur iPhone, ajoutez d’abord cette page à l’écran d’accueil.',
    rowNeedKey: 'Activez d’abord Face ID ou l’empreinte pour ce solde.',
    needKeyTitle: 'D’abord, Face ID ou l’empreinte',
    needKeyText: 'Pour activer les notifications, il faut le Face ID ou l’empreinte de ce solde : ainsi vous seul pouvez vous inscrire. Demandez le QR d’activation à l’accueil.',
    confirmTitle: 'Confirmez que c’est vous',
    confirmText: 'Avec votre Face ID ou votre empreinte, nous activons les notifications sur ce téléphone.',
    confirmGo: 'Activer avec Face ID',
    close: 'Fermer',
    on: 'C’est fait : nous vous avertirons de chaque paiement.',
    off: 'C’est fait : plus de notifications sur ce téléphone.',
    denied: 'Vous avez bloqué les notifications de cette page. Activez-les dans les réglages du navigateur.',
    unsupported: 'Ce navigateur ne peut pas recevoir de notifications.',
    failed: 'Impossible de l’activer. Réessayez.',
    iosTitle: 'Notifications sur iPhone',
    iosSteps: [
      'Touchez Partager (le carré avec la flèche vers le haut).',
      'Choisissez « Sur l’écran d’accueil ».',
      'Ouvrez votre solde depuis la nouvelle icône et touchez « M’avertir de chaque paiement ».',
    ],
    iosNote: 'Il faut iOS 16.4 ou plus récent.',
    iosClose: 'Compris',
    pageTitle: 'C’était vous ?',
    question: 'C’était vous ?',
    atVenue: 'à {venue}',
    when: 'Paiement {ref} · {when}',
    explain:
      'Si ce n’était pas vous, nous bloquons votre badge et votre code PIN pour que personne d’autre ne paie avec. Votre solde reste à vous. Nous prévenons l’accueil pour vérifier le paiement et vous le rembourser si besoin.',
    keep: 'Vous pouvez continuer à payer avec Face ID.',
    go: 'Ce n’est pas moi',
    goBusy: 'Blocage…',
    ifYou: 'Si c’était vous, vous n’avez rien à faire.',
    doneTitle: 'Badge et PIN bloqués',
    doneText: 'Nous avons prévenu l’accueil du paiement {ref}. Passez à l’accueil : ils le vérifient avec vous et vous donnent un nouveau badge.',
    doneNoCard: 'Nous avons prévenu l’accueil du paiement {ref}. Passez à l’accueil pour le vérifier avec vous.',
    alreadyTitle: 'Vous nous l’avez déjà dit',
    alreadyText: 'L’accueil vérifie déjà ce paiement.',
    expiredTitle: 'Ce lien a expiré',
    expiredText: 'Si vous ne reconnaissez pas un paiement, allez à l’accueil.',
    invalidTitle: 'Ce lien n’est pas valable',
    invalidText: 'Si vous ne reconnaissez pas un paiement, allez à l’accueil.',
    notPaidText: 'Ce paiement n’a jamais été payé avec votre solde.',
  },
  pt: {
    locale: 'pt-PT',
    pushTitle: 'Foram cobrados {amount}',
    pushBody: 'Em {venue} · restam-te {balance}',
    pushBodyNoVenue: 'Restam-te {balance}',
    pushNotMe: 'Não fui eu',
    loadVoidTitle: 'Recarga anulada · {partner}',
    loadVoidBody: 'Foram retirados {amount} do teu saldo · restam-te {balance}',
    row: 'Avisar-me de cada cobrança',
    rowOff: 'Recebes um aviso no telemóvel sempre que se paga com o teu saldo.',
    rowOn: 'Ativado neste telemóvel. Toca para o tirar.',
    rowIos: 'No iPhone, primeiro adiciona esta página ao ecrã principal.',
    rowNeedKey: 'Primeiro ativa o Face ID ou a impressão digital neste saldo.',
    needKeyTitle: 'Primeiro, Face ID ou impressão digital',
    needKeyText: 'É preciso o Face ID ou a impressão digital deste saldo para ativar o aviso: assim só tu te inscreves. Pede na receção o QR de ativação.',
    confirmTitle: 'Confirma que és tu',
    confirmText: 'Com o teu Face ID ou a tua impressão digital ativamos o aviso neste telemóvel.',
    confirmGo: 'Ativar com Face ID',
    close: 'Fechar',
    on: 'Pronto: vamos avisar-te de cada cobrança.',
    off: 'Feito: já não te avisamos neste telemóvel.',
    denied: 'Bloqueaste os avisos desta página. Ativa-os nas definições do navegador.',
    unsupported: 'Este navegador não pode receber avisos.',
    failed: 'Não foi possível ativar. Tenta outra vez.',
    iosTitle: 'Avisos no iPhone',
    iosSteps: [
      'Toca em Partilhar (o quadrado com a seta para cima).',
      'Escolhe «Adicionar ao ecrã principal».',
      'Abre o teu saldo pelo ícone novo e toca em «Avisar-me de cada cobrança».',
    ],
    iosNote: 'É preciso iOS 16.4 ou mais recente.',
    iosClose: 'Entendido',
    pageTitle: 'Foste tu?',
    question: 'Foste tu?',
    atVenue: 'em {venue}',
    when: 'Cobrança {ref} · {when}',
    explain:
      'Se não foste tu, bloqueamos a tua ficha e o teu PIN para que mais ninguém pague com eles. O teu saldo continua a ser teu. Avisamos a receção para rever a cobrança e, se for caso disso, devolver-ta.',
    keep: 'Podes continuar a pagar com o Face ID.',
    go: 'Não fui eu',
    goBusy: 'A bloquear…',
    ifYou: 'Se foste tu, não tens de fazer nada.',
    doneTitle: 'Ficha e PIN bloqueados',
    doneText: 'Avisámos a receção da cobrança {ref}. Passa pela receção: revêem-na contigo e dão-te uma ficha nova.',
    doneNoCard: 'Avisámos a receção da cobrança {ref}. Passa pela receção para a rever contigo.',
    alreadyTitle: 'Já nos disseste',
    alreadyText: 'A receção já está a rever esta cobrança.',
    expiredTitle: 'Este link expirou',
    expiredText: 'Se não reconheces uma cobrança, vai à receção.',
    invalidTitle: 'Este link não é válido',
    invalidText: 'Se não reconheces uma cobrança, vai à receção.',
    notPaidText: 'Esta cobrança nunca foi paga com o teu saldo.',
  },
});

export function fillText(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), text);
}
