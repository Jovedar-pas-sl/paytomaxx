import { z } from 'zod';
import type { VenueServiceFee } from './service-fee';

/**
 * Recepción (20261021100000): recargar el saldo del cliente con tarjeta (el
 * datáfono, o el QR en un móvil) o en efectivo, darle una ficha NFC y que
 * elija su PIN. Lo usan el API, la pantalla del datáfono (/pax) y la app del
 * personal (Android, con Web NFC).
 */

/**
 * Tope de una recarga en efectivo: 1.000 €. En España un pago en efectivo en
 * el que una de las partes es un negocio no puede llegar a 1.000 € (Ley
 * 11/2021, art. 7 de la Ley 7/2012); más, con tarjeta.
 */
export const MAX_CASH_TOP_UP_CENTS = 99_999;

/**
 * Los pagos troceados de una misma operación suman (art. 7.1 de la Ley
 * 7/2012): el efectivo que entra en un saldo (y en los sumados a él) en 24 h
 * no puede llegar a 1.000 €. Lo mismo para el efectivo que se devuelve.
 */
export const CASH_LIMIT_CENTS = 100_000;
export const CASH_LIMIT_WINDOW_HOURS = 24;

/** Una recarga en efectivo mal tecleada se anula en este tiempo (después, «Me voy» o el dueño). */
export const CASH_TOP_UP_VOID_WINDOW_MINUTES = 120;

/** Una Idempotency-Key por intento: la genera la pantalla y la repite si se reintenta. */
export const IdempotencyKeySchema = z.string().trim().min(8).max(100);

const CardTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
const CardUidSchema = z.string().trim().max(64).optional();

/**
 * El saldo que se recarga: uno nuevo, el de su código o el de su ficha. Uno
 * nuevo puede llevar ya la ficha NFC nueva que se le da (card/uid): el saldo y
 * la ficha van en la misma operación, así una respuesta perdida no deja al
 * cliente con la ficha vacía y su dinero en un saldo sin ficha.
 */
export const TopUpWalletSchema = z.union([
  z
    .object({ create: z.literal(true), identifier: z.string().trim().max(60).optional(), card: CardTokenSchema.optional(), uid: CardUidSchema })
    .strict(),
  z.object({ code: z.string().trim().min(6).max(10) }).strict(),
  z.object({ card: CardTokenSchema, uid: CardUidSchema }).strict(),
]);
export type TopUpWalletDto = z.infer<typeof TopUpWalletSchema>;

/**
 * Cómo se confirmó una recarga en efectivo a una ficha (estudio de fichas,
 * B2): acercando otra vez la misma ficha (`tap`) o, si no se leía, con
 * «Cargar sin leerla» (`manual`), que queda apuntado en el registro.
 */
export const FICHA_CHECKS = ['tap', 'manual'] as const;
export type FichaCheck = (typeof FICHA_CHECKS)[number];

export const CashTopUpSchema = z.object({
  /** El saldo que se carga (sin la comisión del servicio). */
  amountCents: z.number().int().positive().max(MAX_CASH_TOP_UP_CENTS, 'En efectivo, como mucho 999,99 € por recarga'),
  idempotencyKey: IdempotencyKeySchema,
  wallet: TopUpWalletSchema,
  /**
   * La «Comisión del servicio» que enseñó la pantalla y se cobra encima del
   * saldo («Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)»). Si no
   * es la del local ahora → 409 SERVICE_FEE_CHANGED (con la de ahora). Sin el
   * campo (app anterior) y con la comisión encendida → 409
   * SERVICE_FEE_APP_OUTDATED: así nunca se apunta en la caja una comisión que
   * no se cobró. Apagada, no hace falta.
   */
  serviceFeeCents: z.number().int().nonnegative().max(MAX_CASH_TOP_UP_CENTS).optional(),
  /** B2: cómo se confirmó con la ficha (sin el campo: sin ficha que acercar, o una app anterior). */
  fichaCheck: z.enum(FICHA_CHECKS).optional(),
});
export type CashTopUpDto = z.infer<typeof CashTopUpSchema>;

/** Anular una recarga en efectivo reciente (encargado o dueño, con su 2FA). */
export const CashTopUpVoidSchema = z.object({
  reason: z.string().trim().min(3, 'Explica por qué se anula').max(200),
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
  /**
   * La «Comisión del servicio» de esa recarga que enseñó la pantalla (de la
   * caja sale el saldo + ella). Si la recarga la lleva, es obligatoria: una
   * pantalla de antes, que enseña solo el saldo, recibe 409
   * SERVICE_FEE_APP_OUTDATED (y otra cifra, SERVICE_FEE_CHANGED).
   */
  serviceFeeCents: z.number().int().nonnegative().max(MAX_CASH_TOP_UP_CENTS).optional(),
});
export type CashTopUpVoidDto = z.infer<typeof CashTopUpVoidSchema>;

/**
 * «Me he equivocado» (estudio de fichas, B4): quien cargó en efectivo la
 * deshace en estos segundos, con el motivo y acercando la misma ficha, si el
 * saldo aún la cubre. Sale en Incidencias. Después, la anula el encargado.
 */
export const CASH_TOP_UP_UNDO_SECONDS = 120;

export const CASH_UNDO_REASONS = ['amount', 'ficha', 'unpaid'] as const;
export type CashUndoReason = (typeof CASH_UNDO_REASONS)[number];

/** Los tres motivos, tal cual se ven (y se apuntan en la anulación). */
export const CASH_UNDO_REASON_LABEL: Readonly<Record<CashUndoReason, string>> = {
  amount: 'Importe equivocado',
  ficha: 'Ficha equivocada',
  unpaid: 'No llegó a pagar',
};

export const CashTopUpUndoSchema = z
  .object({
    reason: z.enum(CASH_UNDO_REASONS),
    /** La misma ficha de la recarga, acercada otra vez. */
    card: CardTokenSchema,
    uid: CardUidSchema,
  })
  .strict();
export type CashTopUpUndoDto = z.infer<typeof CashTopUpUndoSchema>;

// ─── Teléfono opcional al dar una ficha nueva (10-nov-2026) ─────────────

/** Debajo del campo, para el cliente. */
export const CONTACT_PHONE_NOTE = 'Solo para encontrar tu saldo si pierdes la ficha';

/**
 * «600 12 34 56», «+34 600-123-456», «0034 600123456» → «600123456» o
 * «+34600123456»: solo cifras (con «+» delante si es internacional), de 6 a
 * 15. null si no lo parece.
 */
export function normalizeContactPhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  const intl = compact.startsWith('+') ? compact : compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return /^[+]?[0-9]{6,15}$/.test(intl) ? intl : null;
}

export const ContactPhoneSchema = z.object({ phone: z.string().trim().min(1).max(32) }).strict();
export type ContactPhoneDto = z.infer<typeof ContactPhoneSchema>;

/** Un saldo encontrado por su teléfono (encargado o dueño): sin el teléfono, que ya lo saben. */
export interface WalletByPhone {
  walletId: string;
  code: string;
  balanceCents: number;
  status: string;
  createdAt: string;
}

/** Lo que devuelve la anulación: la fila negativa y el saldo que queda. */
export interface CashTopUpVoidResult {
  voidId: string;
  topUpId: string;
  walletId: string;
  /** Lo anulado del saldo (positivo). */
  amountCents: number;
  /** Su «Comisión del servicio» (positiva): también se devuelve. De la caja sale amountCents + esta. */
  serviceFeeCents?: number;
  balanceCents: number;
}

/** Recarga con tarjeta en el datáfono de recepción: el importe y el saldo (no hay efectivo). */
export const DeviceCardTopUpSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_00),
  idempotencyKey: IdempotencyKeySchema,
  wallet: z.union([
    z.object({ create: z.literal(true) }).strict(),
    z.object({ card: CardTokenSchema, uid: CardUidSchema }).strict(),
  ]),
});
export type DeviceCardTopUpDto = z.infer<typeof DeviceCardTopUpSchema>;

/** Lo que devuelve una recarga en efectivo: ya está sumada. */
export interface CashTopUpResult {
  topUpId: string;
  walletId: string;
  /** Código del saldo (K7Q-4M2): el cliente lo apunta. */
  code: string;
  /** Lo cargado en el saldo. */
  amountCents: number;
  /** La «Comisión del servicio» cobrada encima (0 sin ella). Opcional: API anterior. */
  serviceFeeCents?: number;
  /** Su % (bps); null = sin comisión. */
  serviceFeeBps?: number | null;
  /** Lo que pagó el cliente en efectivo: saldo + comisión. */
  chargedCents?: number;
  balanceCents: number;
  /** Saldo nuevo (no tenía). */
  createdWallet: boolean;
  /** La misma recarga pedida otra vez (mismo botón): no se ha cargado dos veces. */
  replayed: boolean;
  /** Saldo nuevo con su ficha (wallet.create con card): la ficha quedó dada en la misma operación. */
  cardLinked?: boolean;
}

/** Qué ofrece la recepción en este local y en este aparato. */
export interface ReceptionOptions {
  /** Recarga con tarjeta (en el datáfono: «Datáfono» y «Saldo» encendidos). */
  card: boolean;
  /** Recarga en efectivo (encendida y con permiso). */
  cash: boolean;
  /** Por qué no hay efectivo (null si lo hay). */
  cashBlockedReason: string | null;
  /** Fichas NFC encendidas. */
  nfc: boolean;
  /**
   * «Comisión del servicio» del local (el interruptor y los %): la recepción
   * enseña «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)». Sin
   * el campo (API anterior): apagada (serviceFeeOf).
   */
  serviceFee?: VenueServiceFee;
}

// ─── Recepción exprés (2026-10-24) ───────────────────────────────────────

/**
 * «0522»: el número interno de la ficha NFC con cuatro cifras como mínimo.
 * No es el impreso: en pantalla, una ficha sin número impreso sale como
 * «sin número impreso» (fichaLabel), no como «Ficha nº 0522».
 */
export function fichaNumberText(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(4, '0');
}

/** «Ficha nº 00736903» con el número impreso; si no tiene, «Ficha sin número impreso». */
export function fichaLabel(printedNumber: string | null | undefined): string {
  return printedNumber ? `Ficha nº ${printedNumber}` : 'Ficha sin número impreso';
}

/**
 * El NFC acercado en la recepción (POST /v1/reception/desk) sin saldo vivo:
 * del stock, recién grabado o de un saldo ya cerrado. Se le da a un saldo
 * nuevo al cobrar.
 */
export interface ReceptionDeskNew {
  kind: 'new';
  printedNumber?: string | null;
  /** «Ficha nº 0522». */
  fichaNumber: number;
}

/**
 * Un saldo vivo, por su NFC o por su código: lo que tiene (recepción lo ve
 * para recargarlo o, a la salida, devolverlo), su NFC y lo que se le puede
 * devolver ahora en efectivo.
 */
export interface ReceptionDeskSaldo {
  kind: 'saldo';
  printedNumber?: string | null;
  walletId: string;
  /** K7Q-4M2. */
  code: string;
  balanceCents: number;
  hasPin: boolean;
  /** Es de este local (con tarjeta solo se recarga aquí). */
  isHomeVenue: boolean;
  /** Bloqueado: no se recarga ni paga (sí se le puede devolver). */
  blocked: boolean;
  /** El cliente pulsó «Me voy» en su móvil. */
  closeRequested: boolean;
  /**
   * Lo que se le puede devolver ahora en efectivo: solo lo que entró en
   * efectivo y sin llegar a 1.000 € en 24 h (lo mismo que el «Devolver en
   * efectivo» del encargado).
   */
  cashOutCents: number;
  /** Por qué no se devuelve todo en efectivo (null: se devuelve todo, o no tiene nada). */
  cashOutNote: string | null;
  /** El número de su NFC (null: no tiene). */
  fichaNumber: number | null;
  /** Tiene Face ID: a la salida lo confirma en su móvil (el PIN no basta). */
  hasPasskey?: boolean;
  /** La última recarga, si fue hace menos de RECENT_TOP_UP_MINUTES (A4); null o sin el campo: ninguna. */
  lastTopUp?: RecentTopUp | null;
}

export type ReceptionDeskView = ReceptionDeskNew | ReceptionDeskSaldo;

/**
 * Lo que dura en la fila de la ficha «Cargada hace 2 min: 50 € en efectivo
 * (Sergio)» (estudio de fichas, A4): que no se cargue dos veces lo mismo ni se
 * dude de si se cargó.
 */
export const RECENT_TOP_UP_MINUTES = 10;

/** La última recarga de un saldo, si es reciente (A4). Sin nada que sirva para pagar. */
export interface RecentTopUp {
  /** Cuándo se sumó (ISO). */
  at: string;
  /** Lo que se cargó en el saldo (sin la comisión del servicio). */
  amountCents: number;
  method: 'cash' | 'card';
  /** El nombre de pila de quien la cargó (nunca el email). null: sin nombre, el datáfono o el propio cliente. */
  byName: string | null;
}
