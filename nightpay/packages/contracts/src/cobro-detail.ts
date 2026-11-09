import { z } from 'zod';
import type { ChargeMethod, SectionAmount } from './charge-lines';

/**
 * «Detalle del pago» (entrega 1): lo que ve cada uno al tocar un pago.
 *  - El cliente, en su saldo (/w): sus pagos, con el saldo antes y después.
 *  - La chica o el camarero, en su lista de Cobros: sus cobros y «lo tuyo»
 *    (su comisión, su propina, su parte de una invitación); nunca la parte
 *    del local ni el reparto entero.
 *  - El encargado y el dueño, en el panel: todos, con lo del banco y (el
 *    dueño, y el encargado con el permiso «Informes») el reparto entero.
 * Lo delicado (el móvil, la IP, la tarjeta más allá de los últimos 4 y el
 * historial completo) solo llega con la verificación del momento: sin ella,
 * `sensitive: null` y `verify.required: true` (no es un error).
 * Qué campos lleva cada uno lo decide el API (cobro-detail-policy.ts).
 */

/** Las dos clases de cobro de la lista: con tarjeta (o recarga) y del saldo. */
export const COBRO_KINDS = ['PAYMENT', 'SALDO'] as const;
export type CobroKind = (typeof COBRO_KINDS)[number];

/** La clase en la ruta (`/cobros/PAYMENT/:id`; también en minúsculas). */
export const CobroKindParamSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(COBRO_KINDS));

/**
 * Opcional, pendiente de que el dueño lo confirme: la propina y la comisión
 * del servicio en líneas aparte (importe, propina, comisión y total). Con
 * false, solo el total (que ya las lleva). Para quitarlo basta esta línea:
 * las tres pantallas pintan lo que da `detailAmountRows`.
 */
export const DETAIL_TIP_AND_FEE_APART = true;

export type DetailAmountKey = 'amount' | 'tip' | 'serviceFee' | 'total';

export interface DetailAmountRow {
  key: DetailAmountKey;
  cents: number;
}

/** Las cifras del detalle, en orden. Sin propina ni comisión, solo el total. */
export function detailAmountRows(
  d: Pick<CobroDetail, 'amountCents' | 'tipCents' | 'serviceFeeCents' | 'totalCents'>,
  apart: boolean = DETAIL_TIP_AND_FEE_APART,
): DetailAmountRow[] {
  const total: DetailAmountRow = { key: 'total', cents: d.totalCents };
  if (!apart || (d.tipCents === 0 && d.serviceFeeCents === 0)) return [total];
  return [
    { key: 'amount', cents: d.amountCents },
    ...(d.tipCents !== 0 ? [{ key: 'tip' as const, cents: d.tipCents }] : []),
    ...(d.serviceFeeCents !== 0 ? [{ key: 'serviceFee' as const, cents: d.serviceFeeCents }] : []),
    total,
  ];
}

// ─── Lo básico (lo ven todos los que pueden ver el cobro) ──────────────

/** Una línea de lo cobrado. */
export interface CobroDetailLine {
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  /** La sección (CHICA_SERVICE, VENUE_BAR…; EXTRA en los antiguos). */
  category: string;
  /** «Copa con invitación»: a quién se invitó (su nombre de pila). */
  invitedName: string | null;
}

/** Quién cobró: su nombre (al cliente, solo el de pila; sin nombre, null) y su puesto. */
export interface CobroDetailPerson {
  name: string | null;
  role: string | null;
}

/** Cómo se pagó. */
export interface CobroDetailMethod {
  method: ChargeMethod | null;
  /** «Tarjeta Visa ••4242», «Saldo K7Q-•••», «Datáfono»… (en castellano; la página del cliente traduce con los campos). */
  label: string;
  /** «Visa», «Mastercard»… (con tarjeta). */
  cardBrand: string | null;
  /** Los últimos 4: son básicos (lo de más allá es delicado). */
  cardLast4: string | null;
  /** La ficha NFC del saldo con la que pagó: su número impreso o, sin él, el interno («0522»). */
  fichaNumber: string | null;
  /** Por dónde se autorizó: «QR», «Datáfono», «NFC», «NFC sin PIN», «PIN», «Face ID», «Personal». */
  via: string | null;
  /** «K7Q-•••»: el saldo, sin su código entero. */
  walletHint: string | null;
}

/** Anulado, devuelto o cancelado: qué, cuándo, quién y por qué. */
export interface CobroDetailUndo {
  /** REFUND: devolución a la tarjeta. VOID: consumo del saldo anulado. CANCEL: cobro cancelado sin pagar. */
  kind: 'REFUND' | 'VOID' | 'CANCEL';
  at: string;
  /** Lo devuelto o anulado (null: un cobro cancelado sin pagar). */
  amountCents: number | null;
  /** Quién lo hizo. Al cliente, nunca (es texto interno). */
  by: string | null;
  /** El motivo. Al cliente, nunca. */
  reason: string | null;
  /** Devoluciones: PENDING, SUCCEEDED o FAILED. */
  status: string | null;
}

/**
 * Señales del cobro: lo que conviene saber de un vistazo. Cada uno ve las
 * suyas (cobro-detail-policy.ts): al cliente no se le enseña ninguna.
 */
export const COBRO_FLAGS = [
  /** El cliente lo pagó con el saldo y el banco aprobó también la tarjeta. */
  'PAID_TWICE',
  /** Recarga que hizo el cliente con el enlace del local, antes de llegar. */
  'FROM_HOME',
  /** Pagado con el NFC sin PIN (hasta el tope de la noche). */
  'NFC_NO_PIN',
  /** Cobrado del saldo sin que el cliente lo confirmara (lo aprobó el encargado). */
  'APPROVED_BY_STAFF',
  /** Alguien intentó pagarlo con una copia de la ficha. */
  'CARD_COPY_SUSPECTED',
  /** El banco no pidió 3DS. */
  'NO_3DS',
  /** Tarjeta de fuera de España. */
  'FOREIGN_CARD',
] as const;
export type CobroFlag = (typeof COBRO_FLAGS)[number];

export const COBRO_FLAG_TEXT: Readonly<Record<CobroFlag, string>> = {
  PAID_TWICE: 'Cobrado dos veces',
  FROM_HOME: 'Desde casa',
  NFC_NO_PIN: 'NFC sin PIN',
  APPROVED_BY_STAFF: 'Sin confirmar por el cliente',
  CARD_COPY_SUSPECTED: 'Posible copia de la ficha',
  NO_3DS: 'Sin 3DS',
  FOREIGN_CARD: 'Tarjeta de fuera',
};

/** Lo que ha ganado una persona con este cobro. */
export interface CobroDetailMine {
  /** Su comisión. */
  commissionCents: number;
  /** Su propina. */
  tipCents: number;
  /** Su parte de una invitación. */
  invitationCents: number;
  /** Lo que se le ha descontado (devoluciones o anulaciones). */
  reversedCents: number;
  /** Lo suyo: comisión + propina + invitación − descontado. */
  totalCents: number;
}

/** Lo de cada persona del personal en un cobro (dueño, y encargado con «Informes»). */
export interface CobroDetailStaffShare extends CobroDetailMine {
  personId: string;
  name: string;
  role: string | null;
}

/** El reparto entero. */
export interface CobroDetailSplit {
  /** Lo vendido: importe + propina. */
  soldCents: number;
  /** De lo vendido, lo devuelto o anulado (sin la comisión del servicio). */
  refundedCents: number;
  staff: CobroDetailStaffShare[];
  /** De OxioPay: la comisión del servicio (menos la devuelta) y su % sobre lo vendido. */
  oxioPay: { serviceFeeCents: number; platformCents: number };
  /** Lo que queda para el local. */
  venueCents: number;
}

/** Lo del banco (encargado y dueño). */
export interface CobroDetailBank {
  authCode: string | null;
  /** 3DS: true sí, false no, null no se sabe. */
  secure3ds: boolean | null;
  /** País de la tarjeta, como lo manda el banco (Redsys: ISO numérico, 724 = España). */
  cardCountry: string | null;
  provider: string | null;
  /** El pedido en el banco (o la operación del datáfono). */
  bankOrder: string | null;
}

/** Lo que se sabe de un móvil (sin el User-Agent entero). */
export interface DeviceInfo {
  /** «SM-S918B»; en un iPhone, «iPhone» (no da el modelo). */
  model: string | null;
  /** «iOS», «Android», «Windows»… */
  os: string | null;
  /** «18», «14». */
  osVersion: string | null;
  /** «Safari 18», «Chrome 130», «Instagram». */
  browser: string | null;
  /** Móvil (true), ordenador (false) o no se sabe (null). */
  mobile: boolean | null;
  /** Dentro del navegador de otra app (Instagram, Facebook…): su nombre. */
  inApp: string | null;
}

/** En qué paso se vio el móvil. */
export const DEVICE_STEPS = ['create', 'card', 'saldo', 'pos', 'cancel'] as const;
export type DeviceStep = (typeof DEVICE_STEPS)[number];

/** De quién era: del personal, del cliente o del datáfono. */
export type DeviceWho = 'staff' | 'client' | 'device';

export interface CobroDetailDevice extends DeviceInfo {
  who: DeviceWho;
  step: DeviceStep;
  at: string;
  /** «iPhone · iOS 18 · Safari 18». */
  label: string;
  /** Null: ya se borró (a los 90 días: `ipErased`) o no se supo. */
  ip: string | null;
  ipErased: boolean;
  /** Del personal: quién era. */
  personName: string | null;
}

/** La tarjeta más allá de los últimos 4. */
export interface CobroDetailCardMore {
  /** Crédito o débito, como lo manda el banco. */
  type: string | null;
  /** El código del medio de pago del banco (Ds_ProcessedPayMethod). */
  payMethodCode: string | null;
  /** Caducidad (AAMM) si se guardó la tarjeta para cobros recurrentes. */
  expiry: string | null;
  tokenized: boolean;
}

export interface CobroDetailHistoryItem {
  at: string;
  /** Qué pasó, en castellano llano. */
  what: string;
  detail: string | null;
}

/** Lo delicado: solo con la verificación del momento. */
export interface CobroDetailSensitive {
  devices: CobroDetailDevice[];
  /** Null en los cobros del saldo (y para quien no la ve). */
  card: CobroDetailCardMore | null;
  history: CobroDetailHistoryItem[];
}

/** Si hace falta verificar para ver lo delicado, con qué y hasta cuándo vale. */
export interface CobroDetailVerify {
  required: boolean;
  /** La 2FA si la tiene; si no, su llave de acceso; null: no tiene ninguna (que la active). */
  method: StepUpMethod | null;
  verifiedUntil: string | null;
}

export interface CobroDetail {
  audience: 'CLIENT' | 'STAFF' | 'MANAGER';
  kind: CobroKind;
  id: string;
  /** «C-0012». */
  ref: string | null;
  /** El código que ven a la vez el cliente y el personal («0C1»). */
  confirmationCode: string | null;
  /** El estado del cobro (los del saldo: ACCEPTED, o REVERSED si se anuló). */
  status: string;
  createdAt: string;
  /** Cuándo se pagó (null: sin pagar). */
  paidAt: string | null;
  /** Dónde: el local… */
  venueName: string;
  /** …y la sección (o las secciones) de lo cobrado. Recargas: vacía. */
  sections: SectionAmount[];
  /** Qué. */
  lines: CobroDetailLine[];
  /** Lo que se vendió en una frase («2× Copa · Habitación»). */
  service: string | null;
  isTopUp: boolean;
  amountCents: number;
  tipCents: number;
  /** «Comisión del servicio» que pagó el cliente encima (0 sin ella). */
  serviceFeeCents: number;
  /** Lo pagado: importe + propina + comisión del servicio. */
  totalCents: number;
  /** Quién cobró (null: nadie del local, como una recarga desde casa). */
  chargedBy: CobroDetailPerson | null;
  /** Cómo y a quién: la tarjeta (sus 4 últimos), el saldo o la ficha. */
  method: CobroDetailMethod;
  undo: CobroDetailUndo[];
  flags: CobroFlag[];
  /** El cliente: el saldo antes y después (null: no se sabe, p. ej. en lo antiguo). */
  balance?: { beforeCents: number; afterCents: number } | null;
  /** La chica o el camarero: lo suyo (null: no le da nada). */
  mine?: CobroDetailMine | null;
  /** El dueño, y el encargado con «Informes»: el reparto entero (null en las recargas). */
  split?: CobroDetailSplit | null;
  /** El encargado y el dueño: lo del banco (null en los cobros del saldo). */
  bank?: CobroDetailBank | null;
  /** El enlace al cobro en el panel (pide iniciar sesión), para «Compartir». */
  panelUrl?: string | null;
  /** Lo delicado: null sin la verificación del momento. Nunca al cliente. */
  sensitive?: CobroDetailSensitive | null;
  verify?: CobroDetailVerify;
}

/** «iPhone · iOS 18 · Safari 18» (lo que se sepa). */
export function deviceLabel(d: Pick<DeviceInfo, 'model' | 'os' | 'osVersion' | 'browser' | 'inApp'>): string {
  const os = d.os ? (d.osVersion ? `${d.os} ${d.osVersion}` : d.os) : null;
  const browser = d.inApp ? `dentro de ${d.inApp}` : d.browser;
  const parts = [d.model, os, browser].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' · ') : 'Dispositivo sin identificar';
}

// ─── Buscar un pago ────────────────────────────────────────────────────

/** Lo que puede ser lo tecleado en el buscador de Cobros del panel. */
export interface CobroSearch {
  /** Tal cual (sin espacios a los lados): pedido del banco, autorización… */
  text: string;
  /** El código de confirmación («0C1»): tres letras o cifras. */
  code: string | null;
  /** Los últimos 4 de la tarjeta. */
  cardLast4: string | null;
  /** El número de la ficha NFC: el interno y el impreso, sin ceros delante. */
  ficha: CobroFichaSearch | null;
}

export interface CobroFichaSearch {
  /** El interno («0522» → 522); null si no cabe. */
  number: number | null;
  /** El impreso sin ceros delante («00736903» → «736903»). */
  printedNorm: string;
}

/** «ficha 522», «ficha nº 522», «nfc 0522», «F-0522», «nº 736903» (sin la «F» suelta: «F52» puede ser un código). */
const FICHA_PREFIX = /^(?:(?:ficha|nfc)\s*(?:n[.ºo°]*\s*)?|f\s*-\s*|n[.ºo°]+\s*)/i;
/** «••4242», «*4242», «tarjeta 4242». */
const CARD_PREFIX = /^(?:tarjeta\s*)?[•*·.\s]+/i;

/**
 * Lo tecleado → qué buscar. «0C1» es un código; «4242», los últimos 4 de la
 * tarjeta y también una ficha nº 4242; «••4242» o «*4242», solo la tarjeta;
 * «ficha 522», «F-0522» o «nº 736903», solo la ficha. Lo demás se busca como
 * siempre (referencia, pedido del banco, autorización).
 */
export function parseCobroSearch(raw: string): CobroSearch {
  const text = raw.trim();
  const code = /^[0-9a-z]{3}$/i.test(text) ? text.toUpperCase() : null;
  const cardOnly = CARD_PREFIX.exec(text);
  if (cardOnly && /^\d{4}$/.test(text.slice(cardOnly[0].length))) {
    return { text, code: null, cardLast4: text.slice(cardOnly[0].length), ficha: null };
  }
  const fichaPrefix = FICHA_PREFIX.exec(text);
  const rest = fichaPrefix ? text.slice(fichaPrefix[0].length) : '';
  if (fichaPrefix && /^\d{1,12}$/.test(rest)) {
    return { text, code: null, cardLast4: null, ficha: fichaSearchOf(rest) };
  }
  const plain = /^\d{1,12}$/.test(text) ? text : null;
  return {
    text,
    code,
    cardLast4: plain && plain.length === 4 ? plain : null,
    ficha: plain ? fichaSearchOf(plain) : null,
  };
}

/** «0522» → { number: 522, printedNorm: '522' }. */
export function fichaSearchOf(digits: string): CobroFichaSearch {
  const printedNorm = digits.replace(/^0+(?=\d)/, '');
  const n = Number(printedNorm);
  return { number: Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null, printedNorm };
}

// ─── Compartir ─────────────────────────────────────────────────────────

/** El parámetro del enlace al cobro en el panel (la referencia, «C-0024»). */
export const COBRO_REF_PARAM = 'ref';

/**
 * El enlace al cobro en el panel: `<panel>/?s=hoy&t=cobros&ref=C-0024`. Pide
 * iniciar sesión y no lleva ningún token ni el id del cobro: solo su
 * referencia, que es por local (otro local no lo encuentra). Sin la dirección
 * del panel o sin referencia (cobros antiguos), null.
 */
export function cobroPanelUrl(panelBase: string | null | undefined, ref: string | null | undefined): string | null {
  const base = panelBase?.trim().replace(/\/+$/, '');
  if (!base || !ref) return null;
  return `${base}/?s=hoy&t=cobros&${COBRO_REF_PARAM}=${encodeURIComponent(ref)}`;
}

/** Los estados en castellano llano, para el texto que se comparte. */
export const COBRO_STATUS_TEXT: Readonly<Record<string, string>> = {
  AUTHORIZED: 'Pagado',
  ACCEPTED: 'Pagado',
  PARTIALLY_REFUNDED: 'Devuelto en parte',
  REFUNDED: 'Devuelto',
  REVERSED: 'Anulado',
  CANCELED: 'Cancelado',
  EXPIRED: 'Caducado',
  FAILED: 'No se pudo pagar',
  CREATED: 'Sin pagar',
  AWAITING_CAPTURE: 'Sin pagar',
  AUTHORIZING: 'Esperando al banco',
  ORPHAN: 'Sin confirmar',
};

export function cobroStatusText(status: string): string {
  return COBRO_STATUS_TEXT[status] ?? status;
}

/**
 * El texto corto que se comparte: referencia, importe y estado; cuándo, dónde
 * y qué; cómo se pagó (la tarjeta, solo con sus 4 últimos) y el código; y el
 * enlace al panel. Sale solo de lo básico: nunca el móvil, la IP, el
 * historial, lo que gana cada uno ni el id del cobro.
 */
export function cobroShareText(
  d: Pick<
    CobroDetail,
    'ref' | 'totalCents' | 'status' | 'paidAt' | 'createdAt' | 'venueName' | 'service' | 'isTopUp' | 'method' | 'confirmationCode' | 'panelUrl'
  >,
  fmt: { eur: (cents: number) => string; when: (iso: string) => string },
): string {
  const head = [d.ref ? `Cobro ${d.ref}` : 'Cobro', fmt.eur(d.totalCents), cobroStatusText(d.status)].join(' · ');
  const where = [fmt.when(d.paidAt ?? d.createdAt), d.venueName, d.isTopUp ? 'Recarga de saldo' : d.service].filter(Boolean).join(' · ');
  const how = [shareMethodText(d.method), d.confirmationCode ? `código ${d.confirmationCode}` : null].filter(Boolean).join(' · ');
  return [head, where, how, d.panelUrl ?? null].filter((line): line is string => Boolean(line)).join('\n');
}

/** Cómo se pagó, para compartir: lo de la lista, sin más datos de la tarjeta que sus 4 últimos. */
function shareMethodText(m: CobroDetailMethod): string | null {
  if (!m.method) return null;
  if (m.method === 'SALDO') return m.fichaNumber ? `Saldo · ficha nº ${m.fichaNumber}` : m.walletHint ? `Saldo ${m.walletHint}` : 'Saldo';
  return m.label && m.label !== '—' ? m.label : null;
}

/** «Carlos Pérez» → «Carlos»: el nombre de pila que ve el cliente. Sin nombre, null. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

// ─── Verificación para lo delicado (paso extra, unos 5 minutos) ─────────

/** Lo que dura la verificación del momento para ver lo delicado. */
export const STEP_UP_TTL_SECONDS = 300;

/**
 * 403 de lo delicado pedido aparte sin la verificación del momento (o ya
 * caducada). El detalle no lo da: viene con `sensitive: null`.
 */
export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED';

/**
 * 403 de una acción que pide la 2FA a quien no la tiene pero sí tiene una
 * llave de acceso: que confirme con ella (Face ID o el PIN de su móvil) esa
 * acción (`stepUpAction` en el error) y la repita con la prueba.
 */
export const PASSKEY_REQUIRED_CODE = 'PASSKEY_REQUIRED';

/** Cómo se verifica cada persona: con la 2FA si la tiene; si no, con su llave. */
export type StepUpMethod = 'totp' | 'passkey';

export interface StepUpStatus {
  /** Hasta cuándo vale la verificación de ahora (null: sin verificar o caducada). */
  verifiedUntil: string | null;
  /** Con qué se verificó. */
  verifiedWith: StepUpMethod | null;
  /** Con qué tiene que verificarse: la 2FA si la tiene; si no, su llave (null: no tiene ninguna). */
  method: StepUpMethod | null;
  totpEnabled: boolean;
  passkeys: number;
}

export const StepUpTotpSchema = z.object({
  code: z
    .string()
    .max(20)
    .transform((s) => s.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'El código son 6 cifras')),
});
export type StepUpTotpDto = z.infer<typeof StepUpTotpSchema>;

/** Una llave de acceso del personal (su móvil), sin la clave. */
export interface StaffPasskeyView {
  id: string;
  /** «iPhone · iOS 18»: el móvil con el que se dio de alta. */
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

