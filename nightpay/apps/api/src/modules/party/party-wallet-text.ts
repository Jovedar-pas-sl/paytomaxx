import type { PayLanguage } from '../payments/pay-i18n';

/**
 * Los textos de la página de la pulsera con OxioParty (/w/:token): lo que
 * añade a la del saldo (party-wallet-view.ts). En los cuatro idiomas de la
 * página. `{n}`, `{date}`, `{amount}` e `{iban}` los rellena el JS.
 * Siempre «pulsera» y «caseta».
 */
export interface PartyWalletText {
  balance: string;
  pulsera: string;
  actions: string;
  topUp: string;
  sobra: string;
  lost: string;
  noteUntil: string;
  noteOpen: string;
  noteClosed: string;
  back: string;
  sobraTitle: string;
  sobraUntil: string;
  noFees: string;
  how: string;
  card: string;
  cardNote: string;
  transfer: string;
  transferNote: string;
  donate: string;
  donateNote: string;
  iban: string;
  ibanBad: string;
  mail: string;
  mailBad: string;
  ask: string;
  give: string;
  okTitle: string;
  okText: string;
  okTextMail: string;
  thanksTitle: string;
  thanksText: string;
  okBack: string;
  nothing: string;
  nothingPending: string;
  closed: string;
  pendingTitle: string;
  pendingLocked: string;
  reqCard: string;
  reqTransfer: string;
  reqPending: string;
  mvCard: string;
  mvTransfer: string;
  mvDonate: string;
  lostTitle: string;
  lostText: string;
  lostCode: string;
  lostNow: string;
  lostOk: string;
  topUpLocked: string;
  err: Record<
    'REFUND_CLOSED' | 'NOTHING_TO_REFUND' | 'REFUND_METHOD_UNAVAILABLE' | 'DONATION_OFF' | 'REFUND_AMOUNT_CHANGED' | 'REFUND_INVALID' | 'TOPUP_IN_PROGRESS',
    string
  >;
}

export const PARTY_WALLET_TEXT: Readonly<Record<PayLanguage, PartyWalletText>> = {
  es: {
    balance: 'Saldo disponible',
    pulsera: 'Pulsera {n}',
    actions: 'Tu pulsera',
    topUp: 'Recargar',
    sobra: 'Lo que sobra',
    lost: 'La perdí',
    noteUntil: 'Lo que no gastes se te devuelve: pídelo hasta el {date}.',
    noteOpen: 'Lo que no gastes se te devuelve: pídelo en «Lo que sobra».',
    noteClosed: 'El plazo para pedir lo que sobra terminó el {date}.',
    back: 'Mi pulsera',
    sobraTitle: 'Lo que te sobra',
    sobraUntil: 'Puedes pedirlo hasta el {date}.',
    noFees: 'Sin gastos.',
    how: '¿Cómo lo quieres?',
    card: 'A mi tarjeta',
    cardNote: 'Lo que cargaste con tarjeta vuelve a esa tarjeta, solo. Tarda unos días.',
    transfer: 'Por transferencia',
    transferNote: 'Para lo que cargaste en efectivo. Escribe tu IBAN.',
    donate: 'Donarlo a la comisión de fiestas',
    donateNote: 'Se queda para las fiestas del año que viene.',
    iban: 'Tu IBAN',
    ibanBad: 'Ese IBAN no es válido: revisa que esté completo.',
    mail: 'Tu correo (para el justificante, si quieres)',
    mailBad: 'Ese correo no es válido.',
    ask: 'Pedir mis {amount}',
    give: 'Donar {amount}',
    okTitle: 'Pedido',
    okText: 'Te devolvemos {amount}. Lo hace el organizador desde su banco.',
    okTextMail: 'Te devolvemos {amount}. Te avisamos por correo cuando salga.',
    thanksTitle: '¡Gracias!',
    thanksText: '{amount} para la comisión de fiestas.',
    okBack: 'Volver a mi pulsera',
    nothing: 'No te queda nada por pedir.',
    nothingPending: 'Ya lo has pedido todo: está pendiente.',
    closed: 'El plazo para pedir lo que sobra terminó el {date}.',
    pendingTitle: 'Devolución pedida',
    pendingLocked: 'Mientras tanto, tu saldo está bloqueado: no se puede gastar ni recargar.',
    reqCard: '{amount} a tu tarjeta',
    reqTransfer: '{amount} por transferencia a {iban}',
    reqPending: 'pendiente',
    mvCard: 'Devuelto a tu tarjeta',
    mvTransfer: 'Devuelto por transferencia',
    mvDonate: 'Donado a la comisión',
    lostTitle: '¿Has perdido tu pulsera?',
    lostText: 'Ve a la taquilla: bloquean la perdida y te dan otra con tu saldo. No pierdes nada.',
    lostCode: 'Diles tu código:',
    lostNow: 'Bloquearla ya con mi móvil',
    lostOk: 'Entendido',
    topUpLocked: 'Con una devolución pedida no se puede recargar.',
    err: {
      REFUND_CLOSED: 'El plazo para pedir lo que sobra ya terminó.',
      NOTHING_TO_REFUND: 'No te queda nada por pedir.',
      REFUND_METHOD_UNAVAILABLE: 'Por ahí no puede volver: elige otra forma.',
      DONATION_OFF: 'En esta fiesta no se puede donar: elige otra forma.',
      REFUND_AMOUNT_CHANGED: 'Tu saldo ha cambiado: revisa el importe y vuelve a pedirlo.',
      REFUND_INVALID: 'Revisa los datos.',
      TOPUP_IN_PROGRESS: 'Tienes una recarga a medias: espera unos minutos a que termine y vuelve a pedirlo.',
    },
  },
  en: {
    balance: 'Available balance',
    pulsera: 'Wristband {n}',
    actions: 'Your wristband',
    topUp: 'Top up',
    sobra: 'What’s left',
    lost: 'I lost it',
    noteUntil: 'What you don’t spend comes back to you: ask for it by {date}.',
    noteOpen: 'What you don’t spend comes back to you: ask for it in “What’s left”.',
    noteClosed: 'The deadline to ask for what’s left ended on {date}.',
    back: 'My wristband',
    sobraTitle: 'What you have left',
    sobraUntil: 'You can ask for it until {date}.',
    noFees: 'No fees.',
    how: 'How would you like it?',
    card: 'To my card',
    cardNote: 'What you loaded by card goes back to that card only. It takes a few days.',
    transfer: 'By bank transfer',
    transferNote: 'For what you loaded in cash. Enter your IBAN.',
    donate: 'Donate it to the festival committee',
    donateNote: 'It stays for next year’s festival.',
    iban: 'Your IBAN',
    ibanBad: 'That IBAN isn’t valid: check that it’s complete.',
    mail: 'Your email (for the receipt, if you like)',
    mailBad: 'That email isn’t valid.',
    ask: 'Ask for my {amount}',
    give: 'Donate {amount}',
    okTitle: 'Requested',
    okText: 'We’ll give you back {amount}. The organiser does it from their bank.',
    okTextMail: 'We’ll give you back {amount}. We’ll email you when it’s sent.',
    thanksTitle: 'Thank you!',
    thanksText: '{amount} for the festival committee.',
    okBack: 'Back to my wristband',
    nothing: 'There’s nothing left to ask for.',
    nothingPending: 'You’ve already asked for everything: it’s pending.',
    closed: 'The deadline to ask for what’s left ended on {date}.',
    pendingTitle: 'Refund requested',
    pendingLocked: 'Meanwhile your balance is locked: it can’t be spent or topped up.',
    reqCard: '{amount} to your card',
    reqTransfer: '{amount} by transfer to {iban}',
    reqPending: 'pending',
    mvCard: 'Refunded to your card',
    mvTransfer: 'Refunded by transfer',
    mvDonate: 'Donated to the committee',
    lostTitle: 'Lost your wristband?',
    lostText: 'Go to the ticket booth: they block the lost one and give you another with your balance. You lose nothing.',
    lostCode: 'Tell them your code:',
    lostNow: 'Block it now with my phone',
    lostOk: 'Got it',
    topUpLocked: 'You can’t top up while a refund is pending.',
    err: {
      REFUND_CLOSED: 'The deadline to ask for what’s left has ended.',
      NOTHING_TO_REFUND: 'There’s nothing left to ask for.',
      REFUND_METHOD_UNAVAILABLE: 'It can’t go back that way: choose another option.',
      DONATION_OFF: 'Donations aren’t possible at this festival: choose another option.',
      REFUND_AMOUNT_CHANGED: 'Your balance has changed: check the amount and ask again.',
      REFUND_INVALID: 'Check your details.',
      TOPUP_IN_PROGRESS: 'You have a top-up still going through: wait a few minutes for it to finish and ask again.',
    },
  },
  fr: {
    balance: 'Solde disponible',
    pulsera: 'Bracelet {n}',
    actions: 'Votre bracelet',
    topUp: 'Recharger',
    sobra: 'Ce qui reste',
    lost: 'Je l’ai perdu',
    noteUntil: 'Ce que vous ne dépensez pas vous est rendu : demandez-le avant le {date}.',
    noteOpen: 'Ce que vous ne dépensez pas vous est rendu : demandez-le dans « Ce qui reste ».',
    noteClosed: 'Le délai pour demander ce qui reste a pris fin le {date}.',
    back: 'Mon bracelet',
    sobraTitle: 'Ce qu’il vous reste',
    sobraUntil: 'Vous pouvez le demander jusqu’au {date}.',
    noFees: 'Sans frais.',
    how: 'Comment le voulez-vous ?',
    card: 'Sur ma carte',
    cardNote: 'Ce que vous avez chargé par carte revient sur cette carte uniquement. Cela prend quelques jours.',
    transfer: 'Par virement',
    transferNote: 'Pour ce que vous avez chargé en espèces. Saisissez votre IBAN.',
    donate: 'Le donner au comité des fêtes',
    donateNote: 'Il reste pour les fêtes de l’an prochain.',
    iban: 'Votre IBAN',
    ibanBad: 'Cet IBAN n’est pas valable : vérifiez qu’il est complet.',
    mail: 'Votre e-mail (pour le justificatif, si vous voulez)',
    mailBad: 'Cet e-mail n’est pas valable.',
    ask: 'Demander mes {amount}',
    give: 'Donner {amount}',
    okTitle: 'Demandé',
    okText: 'Nous vous rendons {amount}. L’organisateur le fait depuis sa banque.',
    okTextMail: 'Nous vous rendons {amount}. Nous vous prévenons par e-mail à l’envoi.',
    thanksTitle: 'Merci !',
    thanksText: '{amount} pour le comité des fêtes.',
    okBack: 'Retour à mon bracelet',
    nothing: 'Il ne vous reste rien à demander.',
    nothingPending: 'Vous avez déjà tout demandé : c’est en attente.',
    closed: 'Le délai pour demander ce qui reste a pris fin le {date}.',
    pendingTitle: 'Remboursement demandé',
    pendingLocked: 'En attendant, votre solde est bloqué : il ne peut être ni dépensé ni rechargé.',
    reqCard: '{amount} sur votre carte',
    reqTransfer: '{amount} par virement vers {iban}',
    reqPending: 'en attente',
    mvCard: 'Remboursé sur votre carte',
    mvTransfer: 'Remboursé par virement',
    mvDonate: 'Donné au comité',
    lostTitle: 'Vous avez perdu votre bracelet ?',
    lostText: 'Allez à la billetterie : ils bloquent le bracelet perdu et vous en donnent un autre avec votre solde. Vous ne perdez rien.',
    lostCode: 'Donnez-leur votre code :',
    lostNow: 'Le bloquer tout de suite avec mon téléphone',
    lostOk: 'Compris',
    topUpLocked: 'Impossible de recharger pendant un remboursement en attente.',
    err: {
      REFUND_CLOSED: 'Le délai pour demander ce qui reste a pris fin.',
      NOTHING_TO_REFUND: 'Il ne vous reste rien à demander.',
      REFUND_METHOD_UNAVAILABLE: 'Il ne peut pas revenir par là : choisissez une autre option.',
      DONATION_OFF: 'Les dons ne sont pas possibles à cette fête : choisissez une autre option.',
      REFUND_AMOUNT_CHANGED: 'Votre solde a changé : vérifiez le montant et redemandez-le.',
      REFUND_INVALID: 'Vérifiez vos données.',
      TOPUP_IN_PROGRESS: 'Une recharge est encore en cours : attendez quelques minutes qu’elle se termine et redemandez-le.',
    },
  },
  pt: {
    balance: 'Saldo disponível',
    pulsera: 'Pulseira {n}',
    actions: 'A sua pulseira',
    topUp: 'Carregar',
    sobra: 'O que sobra',
    lost: 'Perdi-a',
    noteUntil: 'O que não gastar é-lhe devolvido: peça-o até {date}.',
    noteOpen: 'O que não gastar é-lhe devolvido: peça-o em «O que sobra».',
    noteClosed: 'O prazo para pedir o que sobra terminou a {date}.',
    back: 'A minha pulseira',
    sobraTitle: 'O que lhe sobra',
    sobraUntil: 'Pode pedi-lo até {date}.',
    noFees: 'Sem custos.',
    how: 'Como o quer receber?',
    card: 'No meu cartão',
    cardNote: 'O que carregou com cartão volta apenas a esse cartão. Demora alguns dias.',
    transfer: 'Por transferência',
    transferNote: 'Para o que carregou em dinheiro. Escreva o seu IBAN.',
    donate: 'Doá-lo à comissão de festas',
    donateNote: 'Fica para as festas do próximo ano.',
    iban: 'O seu IBAN',
    ibanBad: 'Esse IBAN não é válido: verifique se está completo.',
    mail: 'O seu e-mail (para o comprovativo, se quiser)',
    mailBad: 'Esse e-mail não é válido.',
    ask: 'Pedir os meus {amount}',
    give: 'Doar {amount}',
    okTitle: 'Pedido',
    okText: 'Devolvemos-lhe {amount}. O organizador fá-lo a partir do seu banco.',
    okTextMail: 'Devolvemos-lhe {amount}. Avisamos por e-mail quando sair.',
    thanksTitle: 'Obrigado!',
    thanksText: '{amount} para a comissão de festas.',
    okBack: 'Voltar à minha pulseira',
    nothing: 'Não lhe resta nada para pedir.',
    nothingPending: 'Já pediu tudo: está pendente.',
    closed: 'O prazo para pedir o que sobra terminou a {date}.',
    pendingTitle: 'Devolução pedida',
    pendingLocked: 'Entretanto, o seu saldo está bloqueado: não se pode gastar nem carregar.',
    reqCard: '{amount} no seu cartão',
    reqTransfer: '{amount} por transferência para {iban}',
    reqPending: 'pendente',
    mvCard: 'Devolvido ao seu cartão',
    mvTransfer: 'Devolvido por transferência',
    mvDonate: 'Doado à comissão',
    lostTitle: 'Perdeu a sua pulseira?',
    lostText: 'Vá à bilheteira: bloqueiam a perdida e dão-lhe outra com o seu saldo. Não perde nada.',
    lostCode: 'Diga-lhes o seu código:',
    lostNow: 'Bloqueá-la já com o meu telemóvel',
    lostOk: 'Entendido',
    topUpLocked: 'Com uma devolução pedida não se pode carregar.',
    err: {
      REFUND_CLOSED: 'O prazo para pedir o que sobra já terminou.',
      NOTHING_TO_REFUND: 'Não lhe resta nada para pedir.',
      REFUND_METHOD_UNAVAILABLE: 'Por aí não pode voltar: escolha outra forma.',
      DONATION_OFF: 'Nesta festa não se pode doar: escolha outra forma.',
      REFUND_AMOUNT_CHANGED: 'O seu saldo mudou: verifique o valor e volte a pedir.',
      REFUND_INVALID: 'Verifique os dados.',
      TOPUP_IN_PROGRESS: 'Tem um carregamento a meio: espere uns minutos até terminar e volte a pedir.',
    },
  },
};
