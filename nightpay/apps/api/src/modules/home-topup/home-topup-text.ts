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
  /** «Carga tu saldo para {venue}». */
  heading: string;
  /** Por qué cargar antes de llegar, en una línea. */
  advantage: string;
  /** Cómo funciona, en tres pasos (el nombre de la lista, para lectores de pantalla). */
  howTitle: string;
  stepChoose: string;
  stepPay: string;
  /** Al llegar, si el local da fichas: su QR en recepción (el de la página del saldo) o el móvil. */
  stepArrive: string;
  /** Al llegar, si el local no da fichas: el móvil (también en la bienvenida, sin el QR de la ficha). */
  stepArriveNoFicha: string;
  amountLegend: string;
  /** Sin comisión: «Cargar 50 €». */
  go: string;
  /** Con comisión: el botón dice lo que se paga («Pagar 56 €»). */
  goFee: string;
  toBalance: string;
  opening: string;
  methods: string;
  conditionsTitle: string;
  /** Lo que no gaste: delante de que no caduca. */
  keep: string;
  noExpiry: string;
  /** La regla del dueño (17-nov-2026): el saldo no se devuelve, se queda para la próxima visita. */
  keepRule: string;
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
  /** Con el QR de la ficha en la página; sin él, `stepArriveNoFicha`. */
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
  /**
   * «Regala una noche»: «Para regalar» en esta página, la página del regalo
   * (/r/regalo/<token>) y «Comparte tu regalo». Lo que tiene efecto legal
   * (no se devuelve, caduca sin guardar) va aparte: GIFT_LEGAL_TEXT.
   */
  gift: {
    /** ¿Para quién? (la elección, para lectores de pantalla) */
    choiceLabel: string;
    choiceMe: string;
    choiceGift: string;
    /** «Regala saldo para {venue}». */
    heading: string;
    advantage: string;
    stepChoose: string;
    stepShare: string;
    /** Solo en este local (sin grupo). */
    onlyHere: string;
    amountLegend: string;
    nameLabel: string;
    messageLabel: string;
    /** «Regalar 50 €» (sin comisión; con ella, `goFee`). */
    go: string;
    /** La página del regalo (quien lo recibe). */
    title: string;
    /** «Te han regalado {amount} en {venue}». */
    received: string;
    forName: string;
    save: string;
    saveHint: string;
    saveBefore: string;
    claimedTitle: string;
    claimedBody: string;
    expiredTitle: string;
    expiredBody: string;
    /** «Comparte tu regalo» (quien lo pagó, tras pagar). */
    shareTitle: string;
    shareBody: string;
    shareLinkLabel: string;
    shareWhatsapp: string;
    shareCopy: string;
    shareCopied: string;
    /** El texto del mensaje de WhatsApp (con el enlace). */
    shareText: string;
    sharePrivate: string;
  };
  /** Los `code` de los errores de esta función (los demás, los de siempre: client-errors.ts). */
  errors: { HOME_TOPUP_GONE: string; HOME_TOPUP_BUSY: string; HOME_TOPUP_UNAVAILABLE: string; HOME_TOPUP_DAILY: string; GIFT_TEXT: string };
}

const ES: HomeTopUpText = {
  title: 'Cargar saldo',
  heading: 'Carga tu saldo para {venue}',
  advantage: 'Llegas con tu saldo listo, sin esperar en recepción para cargarlo.',
  howTitle: 'Cómo funciona',
  stepChoose: 'Elige cuánto.',
  stepPay: 'Paga con Apple Pay, Google Pay o tarjeta.',
  stepArrive: 'Al llegar, paga con el móvil o enseña tu QR en recepción y te dan tu ficha.',
  stepArriveNoFicha: 'Al llegar, paga con el móvil escaneando el QR del personal.',
  amountLegend: '¿Cuánto quieres cargar?',
  go: 'Cargar {amount}',
  goFee: 'Pagar {amount}',
  toBalance: 'A tu saldo',
  opening: 'Abriendo el pago…',
  methods: 'Sin propina.',
  conditionsTitle: 'Antes de pagar',
  keep: 'Lo que no gastes no se pierde.',
  noExpiry: 'Tu saldo no caduca: lo gastas cuando vengas, hoy u otro día.',
  keepRule: 'El saldo no se devuelve: se queda para la próxima visita.',
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
  receiptHint: 'Guárdalo y enséñalo en recepción.',
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
  gift: {
    choiceLabel: '¿Para quién es?',
    choiceMe: 'Para mí',
    choiceGift: 'Para regalar',
    heading: 'Regala saldo para {venue}',
    advantage: 'Quien lo recibe lo guarda en su móvil y lo gasta cuando venga.',
    stepChoose: 'Elige cuánto y, si quieres, escribe su nombre y un mensaje.',
    stepShare: 'Comparte el enlace del regalo: lo guarda en su móvil.',
    onlyHere: 'El regalo solo vale en {venue}.',
    amountLegend: '¿Cuánto quieres regalar?',
    nameLabel: 'Su nombre (opcional)',
    messageLabel: 'Un mensaje (opcional)',
    go: 'Regalar {amount}',
    title: 'Un regalo para ti',
    received: 'Te han regalado {amount} en {venue}',
    forName: 'Para {name}',
    save: 'Guardar en mi móvil',
    saveHint: 'Lo guardas con Face ID o con un PIN. Después solo lo puedes usar tú.',
    saveBefore: 'Guárdalo antes del {date}.',
    claimedTitle: 'Este regalo ya se ha guardado',
    claimedBody: 'Ya está en el móvil de quien lo guardó.',
    expiredTitle: 'Este regalo ha caducado',
    expiredBody: 'Nadie lo guardó a tiempo. Pregunta en el local.',
    shareTitle: 'Comparte tu regalo',
    shareBody: 'Regalo de {amount} para {venue}. Envía este enlace a quien se lo regalas: con él lo guarda en su móvil.',
    shareLinkLabel: 'Enlace del regalo',
    shareWhatsapp: 'Enviar por WhatsApp',
    shareCopy: 'Copiar enlace',
    shareCopied: '✓ Enlace copiado',
    shareText: 'Te he regalado {amount} para {venue}: {url}',
    sharePrivate: 'Quien tenga el enlace puede guardar el regalo: envíalo solo a esa persona.',
  },
  errors: {
    HOME_TOPUP_GONE: 'Este enlace ya no vale. Pide al local su enlace de ahora.',
    HOME_TOPUP_BUSY: 'Ahora hay muchas cargas a la vez en este local. Prueba en unos minutos.',
    HOME_TOPUP_UNAVAILABLE: 'Ahora no se puede cargar saldo desde aquí. Pregunta en el local.',
    HOME_TOPUP_DAILY: 'Has hecho muchas cargas hoy desde esta conexión. Prueba con los datos del móvil o pide tu saldo en recepción.',
    GIFT_TEXT: 'El nombre va hasta 40 letras y el mensaje hasta 120.',
  },
};

const EN: HomeTopUpText = {
  title: 'Load balance',
  heading: 'Load your balance for {venue}',
  advantage: 'Arrive with your balance ready, without waiting at reception to load it.',
  howTitle: 'How it works',
  stepChoose: 'Choose how much.',
  stepPay: 'Pay with Apple Pay, Google Pay or card.',
  stepArrive: 'When you arrive, pay with your phone or show your QR at reception to get your NFC tag.',
  stepArriveNoFicha: 'When you arrive, pay with your phone by scanning the staff QR.',
  amountLegend: 'How much do you want to load?',
  go: 'Load {amount}',
  goFee: 'Pay {amount}',
  toBalance: 'To your balance',
  opening: 'Opening the payment…',
  methods: 'No tip.',
  conditionsTitle: 'Before you pay',
  keep: 'What you don’t spend isn’t lost.',
  noExpiry: 'Your balance does not expire: spend it whenever you come, today or another day.',
  keepRule: 'Your balance is not refunded: it stays for your next visit.',
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
  receiptHint: 'Keep it and show it at reception.',
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
  gift: {
    choiceLabel: 'Who is it for?',
    choiceMe: 'For me',
    choiceGift: 'As a gift',
    heading: 'Gift balance for {venue}',
    advantage: 'They save it on their phone and spend it whenever they come.',
    stepChoose: 'Choose how much and, if you like, add their name and a message.',
    stepShare: 'Share the gift link: they save it on their phone.',
    onlyHere: 'The gift can only be used at {venue}.',
    amountLegend: 'How much do you want to give?',
    nameLabel: 'Their name (optional)',
    messageLabel: 'A message (optional)',
    go: 'Give {amount}',
    title: 'A gift for you',
    received: 'You’ve been given {amount} at {venue}',
    forName: 'For {name}',
    save: 'Save on my phone',
    saveHint: 'You save it with Face ID or a PIN. After that, only you can use it.',
    saveBefore: 'Save it before {date}.',
    claimedTitle: 'This gift has already been saved',
    claimedBody: 'It’s already on the phone of whoever saved it.',
    expiredTitle: 'This gift has expired',
    expiredBody: 'Nobody saved it in time. Ask at the venue.',
    shareTitle: 'Share your gift',
    shareBody: 'A {amount} gift for {venue}. Send this link to the person it’s for: they use it to save it on their phone.',
    shareLinkLabel: 'Gift link',
    shareWhatsapp: 'Send by WhatsApp',
    shareCopy: 'Copy link',
    shareCopied: '✓ Link copied',
    shareText: 'I’ve given you {amount} for {venue}: {url}',
    sharePrivate: 'Anyone with the link can save the gift: send it only to that person.',
  },
  errors: {
    HOME_TOPUP_GONE: 'This link is no longer valid. Ask the venue for its current link.',
    HOME_TOPUP_BUSY: 'There are many loads at once at this venue right now. Try again in a few minutes.',
    HOME_TOPUP_UNAVAILABLE: 'You can’t load a balance from here right now. Ask at the venue.',
    HOME_TOPUP_DAILY: 'You’ve started a lot of loads from this connection today. Try your mobile data or ask for your balance at reception.',
    GIFT_TEXT: 'The name can be up to 40 characters and the message up to 120.',
  },
};

const FR: HomeTopUpText = withFrenchSpacing({
  title: 'Charger le solde',
  heading: 'Chargez votre solde pour {venue}',
  advantage: 'Arrivez avec votre solde prêt, sans attendre à l’accueil pour le charger.',
  howTitle: 'Comment ça marche',
  stepChoose: 'Choisissez le montant.',
  stepPay: 'Payez par Apple Pay, Google Pay ou carte.',
  stepArrive: 'En arrivant, payez par téléphone ou montrez votre QR à l’accueil pour votre badge NFC.',
  stepArriveNoFicha: 'En arrivant, payez par téléphone en scannant le QR du personnel.',
  amountLegend: 'Combien voulez-vous charger ?',
  go: 'Charger {amount}',
  goFee: 'Payer {amount}',
  toBalance: 'Sur votre solde',
  opening: 'Ouverture du paiement…',
  methods: 'Sans pourboire.',
  conditionsTitle: 'Avant de payer',
  keep: 'Ce que vous ne dépensez pas n’est pas perdu.',
  noExpiry: 'Votre solde n’expire pas : utilisez-le quand vous venez, aujourd’hui ou un autre jour.',
  keepRule: 'Le solde n’est pas remboursé : il reste pour votre prochaine visite.',
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
  receiptHint: 'Gardez-le et montrez-le à l’accueil.',
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
  gift: {
    choiceLabel: 'C’est pour qui ?',
    choiceMe: 'Pour moi',
    choiceGift: 'Pour offrir',
    heading: 'Offrez du solde pour {venue}',
    advantage: 'La personne l’enregistre sur son téléphone et le dépense quand elle vient.',
    stepChoose: 'Choisissez le montant et, si vous voulez, son prénom et un message.',
    stepShare: 'Partagez le lien du cadeau : elle l’enregistre sur son téléphone.',
    onlyHere: 'Le cadeau n’est valable qu’à {venue}.',
    amountLegend: 'Combien voulez-vous offrir ?',
    nameLabel: 'Son prénom (facultatif)',
    messageLabel: 'Un message (facultatif)',
    go: 'Offrir {amount}',
    title: 'Un cadeau pour vous',
    received: 'On vous a offert {amount} à {venue}',
    forName: 'Pour {name}',
    save: 'Enregistrer sur mon téléphone',
    saveHint: 'Vous l’enregistrez avec Face ID ou un code PIN. Ensuite, vous seul pouvez l’utiliser.',
    saveBefore: 'Enregistrez-le avant le {date}.',
    claimedTitle: 'Ce cadeau a déjà été enregistré',
    claimedBody: 'Il est déjà sur le téléphone de la personne qui l’a enregistré.',
    expiredTitle: 'Ce cadeau a expiré',
    expiredBody: 'Personne ne l’a enregistré à temps. Renseignez-vous sur place.',
    shareTitle: 'Partagez votre cadeau',
    shareBody: 'Cadeau de {amount} pour {venue}. Envoyez ce lien à la personne à qui vous l’offrez : avec lui, elle l’enregistre sur son téléphone.',
    shareLinkLabel: 'Lien du cadeau',
    shareWhatsapp: 'Envoyer par WhatsApp',
    shareCopy: 'Copier le lien',
    shareCopied: '✓ Lien copié',
    shareText: 'Je t’offre {amount} pour {venue} : {url}',
    sharePrivate: 'Toute personne qui a le lien peut enregistrer le cadeau : envoyez-le seulement à elle.',
  },
  errors: {
    HOME_TOPUP_GONE: 'Ce lien n’est plus valable. Demandez à l’établissement son lien actuel.',
    HOME_TOPUP_BUSY: 'Il y a beaucoup de chargements en même temps ici. Réessayez dans quelques minutes.',
    HOME_TOPUP_UNAVAILABLE: 'Impossible de charger le solde d’ici pour l’instant. Renseignez-vous sur place.',
    HOME_TOPUP_DAILY: 'Vous avez fait beaucoup de chargements aujourd’hui depuis cette connexion. Essayez avec vos données mobiles ou demandez votre solde à l’accueil.',
    GIFT_TEXT: 'Le prénom fait 40 caractères au plus et le message 120.',
  },
});

const PT: HomeTopUpText = {
  title: 'Carregar saldo',
  heading: 'Carregue o seu saldo para {venue}',
  advantage: 'Chegue com o saldo pronto, sem esperar na receção para o carregar.',
  howTitle: 'Como funciona',
  stepChoose: 'Escolha quanto.',
  stepPay: 'Pague com Apple Pay, Google Pay ou cartão.',
  stepArrive: 'Ao chegar, pague com o telefone ou mostre o seu QR na receção para ter a sua tag NFC.',
  stepArriveNoFicha: 'Ao chegar, pague com o telefone lendo o QR do funcionário.',
  amountLegend: 'Quanto quer carregar?',
  go: 'Carregar {amount}',
  goFee: 'Pagar {amount}',
  toBalance: 'Para o seu saldo',
  opening: 'A abrir o pagamento…',
  methods: 'Sem gorjeta.',
  conditionsTitle: 'Antes de pagar',
  keep: 'O que não gastar não se perde.',
  noExpiry: 'O seu saldo não expira: gaste-o quando vier, hoje ou noutro dia.',
  keepRule: 'O saldo não é devolvido: fica para a sua próxima visita.',
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
  receiptHint: 'Guarde-o e mostre-o na receção.',
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
  gift: {
    choiceLabel: 'Para quem é?',
    choiceMe: 'Para mim',
    choiceGift: 'Para oferecer',
    heading: 'Ofereça saldo para {venue}',
    advantage: 'Quem o recebe guarda-o no telemóvel e gasta-o quando vier.',
    stepChoose: 'Escolha quanto e, se quiser, escreva o nome e uma mensagem.',
    stepShare: 'Partilhe a ligação do presente: a pessoa guarda-o no telemóvel.',
    onlyHere: 'O presente só é válido em {venue}.',
    amountLegend: 'Quanto quer oferecer?',
    nameLabel: 'O nome (opcional)',
    messageLabel: 'Uma mensagem (opcional)',
    go: 'Oferecer {amount}',
    title: 'Um presente para si',
    received: 'Ofereceram-lhe {amount} em {venue}',
    forName: 'Presente para {name}',
    save: 'Guardar no meu telemóvel',
    saveHint: 'Guarda-o com Face ID ou com um PIN. Depois, só você o pode usar.',
    saveBefore: 'Guarde-o antes de {date}.',
    claimedTitle: 'Este presente já foi guardado',
    claimedBody: 'Já está no telemóvel de quem o guardou.',
    expiredTitle: 'Este presente expirou',
    expiredBody: 'Ninguém o guardou a tempo. Pergunte no local.',
    shareTitle: 'Partilhe o seu presente',
    shareBody: 'Presente de {amount} para {venue}. Envie esta ligação a quem o oferece: com ela, a pessoa guarda-o no telemóvel.',
    shareLinkLabel: 'Ligação do presente',
    shareWhatsapp: 'Enviar pelo WhatsApp',
    shareCopy: 'Copiar ligação',
    shareCopied: '✓ Ligação copiada',
    shareText: 'Ofereci-te {amount} para {venue}: {url}',
    sharePrivate: 'Quem tiver a ligação pode guardar o presente: envie-a só a essa pessoa.',
  },
  errors: {
    HOME_TOPUP_GONE: 'Esta ligação já não é válida. Peça ao estabelecimento a ligação atual.',
    HOME_TOPUP_BUSY: 'Há muitos carregamentos ao mesmo tempo neste estabelecimento. Tente daqui a uns minutos.',
    HOME_TOPUP_UNAVAILABLE: 'Agora não é possível carregar saldo a partir daqui. Pergunte no local.',
    HOME_TOPUP_DAILY: 'Fez muitos carregamentos hoje a partir desta ligação. Experimente com os dados móveis ou peça o seu saldo na receção.',
    GIFT_TEXT: 'O nome tem no máximo 40 caracteres e a mensagem 120.',
  },
};

export const HOME_TOPUP_TEXT: Readonly<Record<PayLanguage, HomeTopUpText>> = Object.freeze({ es: ES, en: EN, fr: FR, pt: PT });

/** Los `code` de error propios de esta función. */
export const HOME_TOPUP_ERROR_CODES = ['HOME_TOPUP_GONE', 'HOME_TOPUP_BUSY', 'HOME_TOPUP_UNAVAILABLE', 'HOME_TOPUP_DAILY', 'GIFT_TEXT'] as const;
