import type { PayLanguage } from '../payments/customer-lang';
import { withFrenchSpacing } from '../payments/i18n/typography';

/**
 * Textos de «Cargar saldo antes de llegar» en los cuatro idiomas: la página
 * del enlace del local (/r/<código>) y lo que añade a la página del saldo
 * (/w) el saldo nuevo cargado desde casa (la bienvenida y el QR de la ficha).
 * Aparte de payments/i18n para no tocar sus diccionarios; las mismas reglas
 * (home-topup-text.spec.ts): ninguna clave falta ni sobra, nada vacío, los
 * mismos {huecos}, traducido de verdad, sin el vocabulario del personal y
 * «Apple Pay», «Google Pay» y «Face ID» sin traducir. Lo de la comisión del
 * servicio («¿Qué es?») y los límites, de pay-i18n y del saldo.
 */
export interface HomeTopUpText {
  title: string;
  kick: string;
  /** «Carga tu saldo para {venue}». */
  heading: string;
  intro: string;
  amountLegend: string;
  /** Sin comisión: «Cargar 50 €». */
  go: string;
  /** Con comisión: el botón dice lo que se paga («Pagar 56 €»). */
  goFee: string;
  toBalance: string;
  opening: string;
  methods: string;
  conditionsTitle: string;
  noExpiry: string;
  refund: string;
  /** Solo con la comisión del servicio encendida. */
  refundFee: string;
  onArrival: string;
  mineTitle: string;
  /** «Tu saldo {code} está en este móvil…». */
  mineBody: string;
  mineGo: string;
  mineOr: string;
  offTitle: string;
  offBody: string;
  notFoundTitle: string;
  notFoundBody: string;
  welcomeKick: string;
  /** «Ya puedes usarlo en {venue}». */
  welcomeTitle: string;
  welcomeTitleNoVenue: string;
  welcomeBody: string;
  saveLink: string;
  shareLink: string;
  copied: string;
  fichaQrTitle: string;
  fichaQrHint: string;
  /** «Guardar comprobante» (bienvenida del saldo nuevo): una imagen con el saldo, su código y el QR de la ficha. */
  receiptSave: string;
  receiptHint: string;
  receiptSaved: string;
  receiptFail: string;
  /** Si el móvil no la deja guardar directamente (el navegador de Instagram…): la imagen en grande. */
  receiptHold: string;
  receiptClose: string;
  /** El nombre del archivo, sin acentos ni espacios. */
  receiptFile: string;
  /** Lo que pone la imagen. */
  receiptKick: string;
  receiptSaldo: string;
  receiptShow: string;
  receiptShowNoQr: string;
  /** Con el QR: con él dan la primera ficha, y la imagen se queda guardada. */
  receiptPrivate: string;
  /** Los `code` de los errores de esta función (los demás, los de siempre: client-errors.ts). */
  errors: { HOME_TOPUP_GONE: string; HOME_TOPUP_BUSY: string; HOME_TOPUP_UNAVAILABLE: string; HOME_TOPUP_DAILY: string };
}

const ES: HomeTopUpText = {
  title: 'Cargar saldo',
  kick: 'Antes de llegar',
  heading: 'Carga tu saldo para {venue}',
  intro: 'Pagas ahora con Apple Pay, Google Pay o tarjeta y llegas con tu saldo listo.',
  amountLegend: '¿Cuánto quieres cargar?',
  go: 'Cargar {amount}',
  goFee: 'Pagar {amount}',
  toBalance: 'A tu saldo',
  opening: 'Abriendo el pago…',
  methods: 'Apple Pay, Google Pay o tarjeta. Sin propina.',
  conditionsTitle: 'Antes de pagar',
  noExpiry: 'Tu saldo no caduca: lo gastas cuando vengas, hoy u otro día.',
  refund: 'Si te sobra, pide la devolución en tu saldo («Me voy»): el local te lo devuelve a tu tarjeta, y el banco puede tardar unos días en enseñarlo.',
  refundFee: 'Se devuelve el saldo; la comisión del servicio no se devuelve.',
  onArrival: 'Al llegar, paga con tu móvil o pide en recepción tu ficha para pagar acercándola.',
  mineTitle: 'Ya tienes un saldo aquí',
  mineBody: 'Tu saldo {code} está en este móvil. Recárgalo en vez de crear otro.',
  mineGo: 'Recargar mi saldo',
  mineOr: 'O carga un saldo nuevo:',
  offTitle: 'Ahora no se puede cargar saldo',
  offBody: 'Este local no deja cargar saldo desde aquí en este momento. Pregunta en el local.',
  notFoundTitle: 'Este enlace no vale',
  notFoundBody: 'No existe o el local ya no lo usa. Pide al local su enlace de ahora.',
  welcomeKick: 'Tu saldo está listo',
  welcomeTitle: 'Ya puedes usarlo en {venue}',
  welcomeTitleNoVenue: 'Ya puedes usarlo en el local',
  welcomeBody: 'Al llegar, paga con tu móvil escaneando el QR del personal, o pide tu ficha en recepción.',
  saveLink: 'Guarda este enlace: es tu saldo. Ábrelo al llegar.',
  shareLink: 'Guardar el enlace',
  copied: '✓ Enlace copiado',
  fichaQrTitle: 'Tu ficha en recepción',
  fichaQrHint: 'Enseña este QR en recepción y te dan tu ficha para pagar acercándola.',
  receiptSave: 'Guardar comprobante',
  receiptHint: 'Guárdalo en el móvil y enséñalo en recepción al llegar.',
  receiptSaved: '✓ Comprobante guardado',
  receiptFail: 'No se ha podido crear la imagen. Haz una captura de pantalla.',
  receiptHold: 'Mantén pulsada la imagen y elige «Guardar imagen».',
  receiptClose: 'Cerrar',
  receiptFile: 'comprobante',
  receiptKick: 'Saldo cargado',
  receiptSaldo: 'Tu saldo',
  receiptShow: 'Enséñalo en recepción y te dan tu ficha.',
  receiptShowNoQr: 'Al llegar, paga con tu móvil o dile este código en recepción.',
  receiptPrivate: 'Es personal: no lo compartas.',
  errors: {
    HOME_TOPUP_GONE: 'Este enlace ya no vale. Pide al local su enlace de ahora.',
    HOME_TOPUP_BUSY: 'Ahora hay muchas cargas a la vez en este local. Prueba en unos minutos.',
    HOME_TOPUP_UNAVAILABLE: 'Ahora no se puede cargar saldo desde aquí. Pregunta en el local.',
    HOME_TOPUP_DAILY: 'Has hecho muchas cargas hoy desde esta conexión. Prueba con los datos del móvil o pide tu saldo en recepción.',
  },
};

const EN: HomeTopUpText = {
  title: 'Load balance',
  kick: 'Before you arrive',
  heading: 'Load your balance for {venue}',
  intro: 'Pay now with Apple Pay, Google Pay or card and arrive with your balance ready.',
  amountLegend: 'How much do you want to load?',
  go: 'Load {amount}',
  goFee: 'Pay {amount}',
  toBalance: 'To your balance',
  opening: 'Opening the payment…',
  methods: 'Apple Pay, Google Pay or card. No tip.',
  conditionsTitle: 'Before you pay',
  noExpiry: 'Your balance does not expire: spend it whenever you come, today or another day.',
  refund: 'If you have some left, ask for a refund on your balance page (“I’m leaving”): the venue refunds it to your card, and your bank may take a few days to show it.',
  refundFee: 'The balance is refunded; the service fee is not.',
  onArrival: 'When you arrive, pay with your phone or ask reception for your NFC tag to pay by tapping it.',
  mineTitle: 'You already have a balance here',
  mineBody: 'Your balance {code} is on this phone. Top it up instead of creating another one.',
  mineGo: 'Top up my balance',
  mineOr: 'Or load a new balance:',
  offTitle: 'You can’t load a balance right now',
  offBody: 'This venue isn’t taking balance loads from here at the moment. Ask at the venue.',
  notFoundTitle: 'This link is not valid',
  notFoundBody: 'It doesn’t exist or the venue no longer uses it. Ask the venue for its current link.',
  welcomeKick: 'Your balance is ready',
  welcomeTitle: 'You can now use it at {venue}',
  welcomeTitleNoVenue: 'You can now use it at the venue',
  welcomeBody: 'When you arrive, pay with your phone by scanning the staff QR, or ask reception for your NFC tag.',
  saveLink: 'Save this link: it is your balance. Open it when you arrive.',
  shareLink: 'Save the link',
  copied: '✓ Link copied',
  fichaQrTitle: 'Your NFC tag at reception',
  fichaQrHint: 'Show this QR at reception and they will give you your NFC tag to pay by tapping it.',
  receiptSave: 'Save receipt',
  receiptHint: 'Keep it on your phone and show it at reception when you arrive.',
  receiptSaved: '✓ Receipt saved',
  receiptFail: 'The image couldn’t be created. Take a screenshot instead.',
  receiptHold: 'Press and hold the image and choose “Save image”.',
  receiptClose: 'Close',
  receiptFile: 'receipt',
  receiptKick: 'Balance loaded',
  receiptSaldo: 'Your balance',
  receiptShow: 'Show it at reception to get your NFC tag.',
  receiptShowNoQr: 'When you arrive, pay with your phone or give this code at reception.',
  receiptPrivate: 'It’s personal: don’t share it.',
  errors: {
    HOME_TOPUP_GONE: 'This link is no longer valid. Ask the venue for its current link.',
    HOME_TOPUP_BUSY: 'There are many loads at once at this venue right now. Try again in a few minutes.',
    HOME_TOPUP_UNAVAILABLE: 'You can’t load a balance from here right now. Ask at the venue.',
    HOME_TOPUP_DAILY: 'You’ve started a lot of loads from this connection today. Try your mobile data or ask for your balance at reception.',
  },
};

const FR: HomeTopUpText = withFrenchSpacing({
  title: 'Charger le solde',
  kick: 'Avant d’arriver',
  heading: 'Chargez votre solde pour {venue}',
  intro: 'Payez maintenant avec Apple Pay, Google Pay ou par carte et arrivez avec votre solde prêt.',
  amountLegend: 'Combien voulez-vous charger ?',
  go: 'Charger {amount}',
  goFee: 'Payer {amount}',
  toBalance: 'Sur votre solde',
  opening: 'Ouverture du paiement…',
  methods: 'Apple Pay, Google Pay ou carte. Sans pourboire.',
  conditionsTitle: 'Avant de payer',
  noExpiry: 'Votre solde n’expire pas : utilisez-le quand vous venez, aujourd’hui ou un autre jour.',
  refund: 'S’il vous en reste, demandez le remboursement depuis votre solde (« Je pars ») : l’établissement vous rembourse sur votre carte, et votre banque peut mettre quelques jours à l’afficher.',
  refundFee: 'Le solde est remboursé ; les frais de service ne le sont pas.',
  onArrival: 'En arrivant, payez avec votre téléphone ou demandez à l’accueil votre badge NFC pour payer en l’approchant.',
  mineTitle: 'Vous avez déjà un solde ici',
  mineBody: 'Votre solde {code} est sur ce téléphone. Rechargez-le au lieu d’en créer un autre.',
  mineGo: 'Recharger mon solde',
  mineOr: 'Ou chargez un nouveau solde :',
  offTitle: 'Impossible de charger le solde pour l’instant',
  offBody: 'Cet établissement ne permet pas de charger le solde d’ici en ce moment. Renseignez-vous sur place.',
  notFoundTitle: 'Ce lien n’est pas valable',
  notFoundBody: 'Il n’existe pas ou l’établissement ne l’utilise plus. Demandez-lui son lien actuel.',
  welcomeKick: 'Votre solde est prêt',
  welcomeTitle: 'Vous pouvez l’utiliser chez {venue}',
  welcomeTitleNoVenue: 'Vous pouvez l’utiliser sur place',
  welcomeBody: 'En arrivant, payez avec votre téléphone en scannant le QR du personnel, ou demandez votre badge NFC à l’accueil.',
  saveLink: 'Gardez ce lien : c’est votre solde. Ouvrez-le en arrivant.',
  shareLink: 'Garder le lien',
  copied: '✓ Lien copié',
  fichaQrTitle: 'Votre badge NFC à l’accueil',
  fichaQrHint: 'Montrez ce QR à l’accueil et on vous donne votre badge NFC pour payer en l’approchant.',
  receiptSave: 'Enregistrer le reçu',
  receiptHint: 'Gardez-le sur votre téléphone et montrez-le à l’accueil en arrivant.',
  receiptSaved: '✓ Reçu enregistré',
  receiptFail: 'Impossible de créer l’image. Faites une capture d’écran.',
  receiptHold: 'Appuyez longuement sur l’image et choisissez « Enregistrer l’image ».',
  receiptClose: 'Fermer',
  receiptFile: 'recu',
  receiptKick: 'Solde chargé',
  receiptSaldo: 'Votre solde',
  receiptShow: 'Montrez-le à l’accueil pour recevoir votre badge NFC.',
  receiptShowNoQr: 'En arrivant, payez avec votre téléphone ou donnez ce code à l’accueil.',
  receiptPrivate: 'Il est personnel : ne le partagez pas.',
  errors: {
    HOME_TOPUP_GONE: 'Ce lien n’est plus valable. Demandez à l’établissement son lien actuel.',
    HOME_TOPUP_BUSY: 'Il y a beaucoup de chargements en même temps ici. Réessayez dans quelques minutes.',
    HOME_TOPUP_UNAVAILABLE: 'Impossible de charger le solde d’ici pour l’instant. Renseignez-vous sur place.',
    HOME_TOPUP_DAILY: 'Vous avez fait beaucoup de chargements aujourd’hui depuis cette connexion. Essayez avec vos données mobiles ou demandez votre solde à l’accueil.',
  },
});

const PT: HomeTopUpText = {
  title: 'Carregar saldo',
  kick: 'Antes de chegar',
  heading: 'Carregue o seu saldo para {venue}',
  intro: 'Pague já com Apple Pay, Google Pay ou cartão e chegue com o saldo pronto.',
  amountLegend: 'Quanto quer carregar?',
  go: 'Carregar {amount}',
  goFee: 'Pagar {amount}',
  toBalance: 'Para o seu saldo',
  opening: 'A abrir o pagamento…',
  methods: 'Apple Pay, Google Pay ou cartão. Sem gorjeta.',
  conditionsTitle: 'Antes de pagar',
  noExpiry: 'O seu saldo não expira: gaste-o quando vier, hoje ou noutro dia.',
  refund: 'Se lhe sobrar, peça a devolução na página do saldo («Vou embora»): o estabelecimento devolve-lhe no cartão, e o banco pode demorar alguns dias a mostrá-lo.',
  refundFee: 'Devolve-se o saldo; a taxa de serviço não é devolvida.',
  onArrival: 'Ao chegar, pague com o telefone ou peça na receção a sua tag NFC para pagar aproximando-a.',
  mineTitle: 'Já tem um saldo aqui',
  mineBody: 'O seu saldo {code} está neste telefone. Carregue-o em vez de criar outro.',
  mineGo: 'Carregar o meu saldo',
  mineOr: 'Ou carregue um saldo novo:',
  offTitle: 'Agora não é possível carregar saldo',
  offBody: 'Este estabelecimento não permite carregar saldo a partir daqui neste momento. Pergunte no local.',
  notFoundTitle: 'Esta ligação não é válida',
  notFoundBody: 'Não existe ou o estabelecimento já não a usa. Peça-lhe a ligação atual.',
  welcomeKick: 'O seu saldo está pronto',
  welcomeTitle: 'Já o pode usar em {venue}',
  welcomeTitleNoVenue: 'Já o pode usar no estabelecimento',
  welcomeBody: 'Ao chegar, pague com o telefone lendo o QR do funcionário, ou peça a sua tag NFC na receção.',
  saveLink: 'Guarde esta ligação: é o seu saldo. Abra-a ao chegar.',
  shareLink: 'Guardar a ligação',
  copied: '✓ Ligação copiada',
  fichaQrTitle: 'A sua tag NFC na receção',
  fichaQrHint: 'Mostre este QR na receção e recebe a sua tag NFC para pagar aproximando-a.',
  receiptSave: 'Guardar comprovativo',
  receiptHint: 'Guarde-o no telemóvel e mostre-o na receção quando chegar.',
  receiptSaved: '✓ Comprovativo guardado',
  receiptFail: 'Não foi possível criar a imagem. Faça uma captura de ecrã.',
  receiptHold: 'Mantenha a imagem premida e escolha «Guardar imagem».',
  receiptClose: 'Fechar',
  receiptFile: 'comprovativo',
  receiptKick: 'Saldo carregado',
  receiptSaldo: 'O seu saldo',
  receiptShow: 'Mostre-o na receção para receber a sua tag NFC.',
  receiptShowNoQr: 'Quando chegar, pague com o telemóvel ou diga este código na receção.',
  receiptPrivate: 'É pessoal: não o partilhe.',
  errors: {
    HOME_TOPUP_GONE: 'Esta ligação já não é válida. Peça ao estabelecimento a ligação atual.',
    HOME_TOPUP_BUSY: 'Há muitos carregamentos ao mesmo tempo neste estabelecimento. Tente daqui a uns minutos.',
    HOME_TOPUP_UNAVAILABLE: 'Agora não é possível carregar saldo a partir daqui. Pergunte no local.',
    HOME_TOPUP_DAILY: 'Fez muitos carregamentos hoje a partir desta ligação. Experimente com os dados móveis ou peça o seu saldo na receção.',
  },
};

export const HOME_TOPUP_TEXT: Readonly<Record<PayLanguage, HomeTopUpText>> = Object.freeze({ es: ES, en: EN, fr: FR, pt: PT });

/** Los `code` de error propios de esta función. */
export const HOME_TOPUP_ERROR_CODES = ['HOME_TOPUP_GONE', 'HOME_TOPUP_BUSY', 'HOME_TOPUP_UNAVAILABLE', 'HOME_TOPUP_DAILY'] as const;
