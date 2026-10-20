import { createHash } from 'node:crypto';

/**
 * Cómo es el pase del saldo en Google Wallet (tipo "Generic").
 *
 * Por qué Generic y no "Gift card": la tarjeta regalo de Google exige un
 * número de tarjeta visible (cardNumber) y su código de barras es para
 * canjearla en caja (allowBarcodeRedemption). Aquí no hay número que
 * enseñar (el código del saldo + el PIN pagan: no va en el pase) y el QR solo
 * sirve para cobrar en el datáfono con el PIN. Generic deja poner el saldo bien grande
 * (header), el local (subheader) y la marca (cardTitle) sin campos falsos.
 * Docs: https://developers.google.com/wallet/generic/rest/v1/genericobject
 *
 * En el pase NUNCA van el PIN, la llave (Face ID) ni el código del saldo.
 * El QR es /c/<token> (pass-charge-token.ts): solo para cobrar en el
 * datáfono, con el PIN; un móvil que lo lea no abre nada. El enlace «Ver mi
 * saldo» (linksModuleData) sí es el de la página del saldo (/w/<token>), el
 * mismo que ya tiene; para verlo hay que desbloquear el móvil
 * (viewUnlockRequirement) y solo lo puede guardar una cuenta de Google.
 */

export type PassState = 'ACTIVE' | 'INACTIVE';

interface TranslatedString {
  language: string;
  value: string;
}

export interface LocalizedString {
  defaultValue: TranslatedString;
  translatedValues?: TranslatedString[];
}

export interface GenericClass {
  id: string;
  multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES';
  viewUnlockRequirement: 'UNLOCK_REQUIRED_TO_VIEW';
}

export interface GenericObject {
  id: string;
  classId: string;
  state: PassState;
  cardTitle: LocalizedString;
  subheader: LocalizedString;
  header: LocalizedString;
  hexBackgroundColor: string;
  barcode: { type: 'QR_CODE'; value: string; alternateText: string };
  textModulesData: Array<{ id: string; header: string; body: string; localizedHeader: LocalizedString; localizedBody: LocalizedString }>;
  linksModuleData: { uris: Array<{ id: string; uri: string; description: string; localizedDescription: LocalizedString }> };
}

/** Lo que cambia en un pase cuyo enlace ya no vale (el dueño dio uno nuevo). */
export type RevokedPassPatch = Pick<GenericObject, 'state' | 'header' | 'textModulesData'>;

/** Lo que hace falta del saldo para pintar su pase. */
export interface PassWallet {
  balanceCents: number;
  /** WalletStatus: ACTIVE | DEPLETED | EXPIRED | REFUNDED. */
  status: string;
  /** Se sumó a otro saldo del mismo cliente (este queda a 0 para siempre). */
  merged: boolean;
  venueName: string | null;
}

/** Verde profundo de la tarjeta OxioCard (Google pone el texto en blanco encima). */
const BACKGROUND = '#004820';
const LANG = { es: 'es', en: 'en' } as const;
/** 40 cifras hex = 160 bits del hash: único de sobra y un id corto. */
const OBJECT_HASH_CHARS = 40;

const TEXT = {
  es: {
    locale: 'es-ES',
    balance: 'Saldo',
    howTitle: 'Cómo se paga',
    how: 'Escanea el QR del personal y desbloquea tu móvil, o di tu código y tu PIN. Este pase se actualiza solo.',
    statusTitle: 'Estado',
    closed: 'Este saldo ya está cerrado.',
    merged: 'Esta recarga se sumó a tu otro saldo.',
    open: 'Ver mi saldo',
    revoked: 'Enlace antiguo',
    revokedBody: 'Este pase ya no se actualiza: el saldo tiene un enlace nuevo. Añádelo otra vez desde ese enlace.',
  },
  en: {
    locale: 'en-GB',
    balance: 'Balance',
    howTitle: 'How to pay',
    how: 'Scan the staff QR and unlock your phone, or say your code and your PIN. This pass updates itself.',
    statusTitle: 'Status',
    closed: 'This balance is closed.',
    merged: 'This top-up was added to your other balance.',
    open: 'Open my balance',
    revoked: 'Old link',
    revokedBody: 'This pass no longer updates: your balance has a new link. Add it again from that link.',
  },
} as const;

/** sha256 del enlace del saldo (hex). Lo que se guarda en vez del token. */
export function linkHash(qrToken: string): string {
  return createHash('sha256').update(qrToken, 'utf8').digest('hex');
}

/** Id del pase en Google: emisor + clase + hash del enlace (nunca el token). */
export function passObjectId(settings: { issuerId: string; classSuffix: string }, tokenHash: string): string {
  return `${settings.issuerId}.${settings.classSuffix}-${tokenHash.slice(0, OBJECT_HASH_CHARS)}`;
}

/** Saldo caducado, devuelto o sumado a otro → el pase pasa a "Caducados". */
export function passState(status: string, merged: boolean): PassState {
  if (merged || status === 'EXPIRED' || status === 'REFUNDED') return 'INACTIVE';
  return 'ACTIVE';
}

/** 20000 → "200,00 €" (es) / "€200.00" (en). */
export function formatBalance(cents: number, lang: keyof typeof TEXT): string {
  return (cents / 100).toLocaleString(TEXT[lang].locale, { style: 'currency', currency: 'EUR' });
}

/** Clase de todos los pases del saldo: una cuenta de Google y desbloqueo para verlo. */
export function genericClass(classId: string): GenericClass {
  return {
    id: classId,
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    viewUnlockRequirement: 'UNLOCK_REQUIRED_TO_VIEW',
  };
}

export function genericObject(input: {
  objectId: string;
  classId: string;
  brand: string;
  /** https://api.dominio/w/<token>: la página del saldo (solo el enlace «Ver mi saldo»). */
  walletUrl: string;
  /** https://api.dominio/c/<token>: el QR, solo para cobrar en el datáfono. */
  chargeUrl: string;
  wallet: PassWallet;
}): GenericObject {
  const { wallet } = input;
  const state = passState(wallet.status, wallet.merged);
  const statusText = state === 'INACTIVE' ? (wallet.merged ? 'merged' : 'closed') : null;
  const modules: GenericObject['textModulesData'] = [
    textModule('como', TEXT.es.howTitle, TEXT.en.howTitle, TEXT.es.how, TEXT.en.how),
  ];
  if (statusText) {
    modules.unshift(textModule('estado', TEXT.es.statusTitle, TEXT.en.statusTitle, TEXT.es[statusText], TEXT.en[statusText]));
  }
  return {
    id: input.objectId,
    classId: input.classId,
    state,
    cardTitle: localized(input.brand, input.brand),
    subheader: wallet.venueName ? localized(wallet.venueName, wallet.venueName) : localized(TEXT.es.balance, TEXT.en.balance),
    header: localized(formatBalance(wallet.balanceCents, 'es'), formatBalance(wallet.balanceCents, 'en')),
    hexBackgroundColor: BACKGROUND,
    barcode: { type: 'QR_CODE', value: input.chargeUrl, alternateText: input.brand },
    textModulesData: modules,
    linksModuleData: {
      uris: [{ id: 'saldo', uri: input.walletUrl, description: TEXT.es.open, localizedDescription: localized(TEXT.es.open, TEXT.en.open) }],
    },
  };
}

/**
 * El dueño dio un enlace nuevo al saldo (lo perdió o le robaron el móvil):
 * el pase viejo se apaga y deja de recibir el saldo.
 */
export function revokedObjectPatch(): RevokedPassPatch {
  return {
    state: 'INACTIVE',
    header: localized(TEXT.es.revoked, TEXT.en.revoked),
    textModulesData: [
      textModule('estado', TEXT.es.statusTitle, TEXT.en.statusTitle, TEXT.es.revokedBody, TEXT.en.revokedBody),
    ],
  };
}

function localized(es: string, en: string): LocalizedString {
  return { defaultValue: { language: LANG.es, value: es }, translatedValues: [{ language: LANG.en, value: en }] };
}

function textModule(id: string, headerEs: string, headerEn: string, bodyEs: string, bodyEn: string) {
  return {
    id,
    header: headerEs,
    body: bodyEs,
    localizedHeader: localized(headerEs, headerEn),
    localizedBody: localized(bodyEs, bodyEn),
  };
}
