import { z } from 'zod';
import { isValidIban } from './operators';
import { normalizeIban } from './superadmin';

// ═══════════════════════════════════════════════════════════════════════
// OxioParty: «Lo que sobra», la devolución que pide el asistente desde la
// página de su pulsera (solo con EDITION=party; con club, 404).
//
// El asistente (con la credencial de su página: el enlace y, si tiene Face ID,
// su sesión y su llave):
//   GET  /w/:token/sobra              lo que puede pedir, por qué vía y sus peticiones
//   POST /w/:token/sobra/challenge    reto para su llave (solo si el saldo tiene Face ID)
//   POST /w/:token/sobra              pedirlo { method, iban?, email?, expectedAmountCents?, response? }
// El organizador (dueño y encargado):
//   GET  /v1/admin/party/refunds?status=&method=      la lista con los totales
//   POST /v1/admin/party/refunds/:id/done             «Hecha» (tarjeta: ya devuelta en el banco; transferencia: ya enviada)
//   POST /v1/admin/party/refunds/:id/cancel           anularla (el saldo vuelve a poder gastarse)
//   GET  /v1/admin/party/refunds/transferencias.csv   las transferencias pendientes, para el banco
//   GET  /v1/admin/party/refunds/transferencias.sepa  las mismas en un fichero SEPA (pain.001.001.03; 409 NO_DEBTOR_IBAN sin la cuenta del local)
//
// Vías: CARD (solo lo cargado con tarjeta; el organizador la hace a mano en el
// banco: hoy Redsys no devuelve por API), TRANSFER (lo cargado en efectivo, a
// su IBAN) y DONATE (a la comisión de fiestas, si el local lo deja: hecha al
// momento). Al pedirla, el saldo queda bloqueado (no se gasta ni se recarga).
// El plazo: venues.refundDeadline (último día, hora de Madrid); pasado, no se pide.
//
// Quien solo tenga una foto del QR tiene el enlace: por internet, la tarjeta
// sí (el dinero vuelve a la tarjeta que pagó), pero la transferencia y donar
// solo con Face ID verificado en la misma petición (sin él, 409
// REFUND_NEEDS_FACE_ID: Face ID o la taquilla, que devuelve el efectivo).
// ═══════════════════════════════════════════════════════════════════════

export const PARTY_REFUND_METHODS = ['CARD', 'TRANSFER', 'DONATE'] as const;
export type PartyRefundMethod = (typeof PARTY_REFUND_METHODS)[number];
export const PartyRefundMethodSchema = z.enum(PARTY_REFUND_METHODS);

/** Por internet, ¿pide Face ID? La tarjeta no (vuelve a la que pagó); la transferencia y donar, sí. */
export function refundNeedsFaceId(method: PartyRefundMethod): boolean {
  return method !== 'CARD';
}

export const REFUND_NEEDS_FACE_ID_MESSAGE = 'Para transferencia o donar, activa Face ID o pásate por la taquilla.';

export const PARTY_REFUND_STATUSES = ['PENDING', 'DONE', 'CANCELED'] as const;
export type PartyRefundStatus = (typeof PARTY_REFUND_STATUSES)[number];
export const PartyRefundStatusSchema = z.enum(PARTY_REFUND_STATUSES);

export const PARTY_REFUND_METHOD_LABEL: Readonly<Record<PartyRefundMethod, string>> = {
  CARD: 'A la tarjeta',
  TRANSFER: 'Transferencia',
  DONATE: 'Donado',
};

export const PARTY_REFUND_STATUS_LABEL: Readonly<Record<PartyRefundStatus, string>> = {
  PENDING: 'Pendiente',
  DONE: 'Hecha',
  CANCELED: 'Anulada',
};

/** Códigos estables de los errores (las páginas y el panel los distinguen). */
export const PARTY_REFUND_ERRORS = {
  closed: 'REFUND_CLOSED',
  nothing: 'NOTHING_TO_REFUND',
  method: 'REFUND_METHOD_UNAVAILABLE',
  donation: 'DONATION_OFF',
  changed: 'REFUND_AMOUNT_CHANGED',
  blocked: 'WALLET_BLOCKED',
  notPending: 'REFUND_NOT_PENDING',
  balance: 'REFUND_BALANCE_CHANGED',
  /** Una recarga del saldo a medias (aún sin respuesta del banco): primero que termine. */
  topUp: 'TOPUP_IN_PROGRESS',
  /** Transferencia o donar por internet con un saldo sin Face ID. */
  faceId: 'REFUND_NEEDS_FACE_ID',
} as const;

/** IBAN del asistente: sin espacios y en mayúsculas, con su dígito de control (mod-97). */
export const RefundIbanSchema = z
  .string()
  .max(50)
  .transform(normalizeIban)
  .refine(isValidIban, 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra)');

/** El correo para el justificante: opcional; vacío = sin correo. */
const RefundEmailSchema = z
  .string()
  .trim()
  .max(254)
  .transform((v) => v.toLowerCase())
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Ese correo no es válido')
  .transform((v) => (v === '' ? null : v));

export const PartyRefundAskSchema = z
  .object({
    method: PartyRefundMethodSchema,
    iban: RefundIbanSchema.nullable().optional(),
    email: RefundEmailSchema.nullable().optional(),
    /** El importe que vio el asistente: si ya es otro, 409 REFUND_AMOUNT_CHANGED en vez de pedir otra cosa. */
    expectedAmountCents: z.number().int().positive().max(100_000_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'TRANSFER' && !v.iban) ctx.addIssue({ code: 'custom', path: ['iban'], message: 'Escribe tu IBAN para la transferencia' });
    if (v.method !== 'TRANSFER' && v.iban) ctx.addIssue({ code: 'custom', path: ['iban'], message: 'El IBAN solo va con la transferencia' });
  });
export type PartyRefundAskDto = z.infer<typeof PartyRefundAskSchema>;

/** Una petición, vista por el asistente (sin el IBAN entero). */
export interface PartyRefundMine {
  id: string;
  method: PartyRefundMethod;
  amountCents: number;
  status: Exclude<PartyRefundStatus, 'CANCELED'>;
  createdAt: string;
  doneAt: string | null;
  /** «ES91 •••• •••• 1332» (solo en una transferencia). */
  ibanHint: string | null;
}

/** «Lo que sobra» en la página de la pulsera. */
export interface PartyRefundView {
  /** Último día para pedirlo (AAAA-MM-DD, hora de Madrid); null: sin plazo. */
  deadline: string | null;
  /** Dentro del plazo (con fecha pasada: false). */
  open: boolean;
  /** El local deja donar lo que sobra a la comisión. */
  allowDonation: boolean;
  balanceCents: number;
  /**
   * Lo que hay ahora por cada vía (0: por esa vía, nada). Sin Face ID, la
   * transferencia y donar no se piden por internet (refundNeedsFaceId).
   */
  available: Record<PartyRefundMethod, number>;
  /** El saldo tiene Face ID: con él, también transferencia y donar por internet. */
  faceId: boolean;
  /** El saldo está bloqueado por una petición pendiente: no se gasta ni se recarga. */
  locked: boolean;
  /** Sus peticiones pendientes y hechas (las anuladas no). */
  requests: PartyRefundMine[];
}

/** Una petición en el panel del organizador. */
export interface PartyRefundRow {
  id: string;
  method: PartyRefundMethod;
  status: PartyRefundStatus;
  amountCents: number;
  createdAt: string;
  doneAt: string | null;
  /** Quién la marcó hecha o la anuló (su nombre o lo de antes de la @). */
  doneByName: string | null;
  /** «P-0412» (la pulsera dada al saldo, o la última que tuvo). */
  pulsera: string | null;
  /** El código del saldo (K7Q-4M2). */
  walletCode: string | null;
  /** Tapado («ES91 •••• •••• 1332»): el entero, solo en el CSV para el banco. */
  ibanHint: string | null;
  email: string | null;
}

export interface PartyRefundTotal {
  count: number;
  cents: number;
}

export interface PartyRefundTotals {
  /** Por estado y método (las anuladas, aparte). */
  pending: Record<PartyRefundMethod, PartyRefundTotal>;
  done: Record<PartyRefundMethod, PartyRefundTotal>;
  canceled: PartyRefundTotal;
  /** Lo donado a la comisión (hecho). */
  donatedCents: number;
}

export interface PartyRefundList {
  rows: PartyRefundRow[];
  totals: PartyRefundTotals;
}

export const PartyRefundListQuerySchema = z.object({
  status: PartyRefundStatusSchema.optional(),
  method: PartyRefundMethodSchema.optional(),
});
export type PartyRefundListQuery = z.infer<typeof PartyRefundListQuerySchema>;

// ─── El plazo ───────────────────────────────────────────────────────────

const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** El día de hoy en Madrid (AAAA-MM-DD). */
export function madridDay(now: Date = new Date()): string {
  return MADRID_DAY.format(now);
}

/** ¿Se puede pedir aún? Sin plazo, sí; con él, hasta ese día incluido (hora de Madrid). */
export function isRefundWindowOpen(deadline: string | null | undefined, now: Date = new Date()): boolean {
  if (!deadline) return true;
  return madridDay(now) <= deadline;
}
