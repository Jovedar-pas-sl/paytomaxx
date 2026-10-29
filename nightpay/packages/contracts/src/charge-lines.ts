import { z } from 'zod';
import { UuidSchema } from './common';
import { SectionCodeSchema, type SectionCode } from './sections';

/**
 * Líneas de un cobro (el mapa del dinero). Un cobro con tarjeta o del saldo
 * puede llevar varias cosas («2 copas y una habitación»): cada línea va a su
 * sección y el cliente paga una sola vez. El total lo calcula el servidor.
 *
 *  - { serviceItemId, qty }               → de la carta: precio y sección del
 *    local (un pack da una línea por parte).
 *  - { category, amountCents, label? }    → importe tecleado en una sección.
 */
export const MAX_CHARGE_LINES = 20;
export const MAX_LINE_QTY = 50;
/** Tope de un cobro (el mismo que el de un importe suelto). */
export const MAX_CHARGE_CENTS = 10_000_00;

export const CartaLineInputSchema = z
  .object({
    serviceItemId: UuidSchema,
    qty: z.number().int().min(1).max(MAX_LINE_QTY).default(1),
  })
  .strict();

export const AmountLineInputSchema = z
  .object({
    category: SectionCodeSchema,
    amountCents: z.number().int().positive().max(MAX_CHARGE_CENTS),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const ChargeLineInputSchema = z.union([CartaLineInputSchema, AmountLineInputSchema]);
export type ChargeLineInput = z.infer<typeof ChargeLineInputSchema>;

export const ChargeLinesSchema = z
  .array(ChargeLineInputSchema)
  .min(1, 'Añade algo que cobrar')
  .max(MAX_CHARGE_LINES, `Como mucho ${MAX_CHARGE_LINES} líneas por cobro`);

/** Una línea ya guardada (en la respuesta del cobro y en las fichas). */
export interface ChargeLineView {
  category: SectionCode;
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  serviceItemId: string | null;
  /** «Copa con invitación»: la chica invitada (null: no es una invitación). */
  beneficiaryOperatorId?: string | null;
}

/** Lo cobrado de cada sección en un cobro. */
export interface SectionAmount {
  category: string;
  amountCents: number;
}

// ─── Packs de la carta ────────────────────────────────────────────────

export const MAX_PACK_COMPONENTS = 4;

export const PackComponentSchema = z
  .object({
    category: SectionCodeSchema,
    amountCents: z.number().int().positive().max(MAX_CHARGE_CENTS),
  })
  .strict();
export type PackComponent = z.infer<typeof PackComponentSchema>;

export const PackComponentsSchema = z
  .array(PackComponentSchema)
  .min(2, 'Un pack tiene al menos dos partes')
  .max(MAX_PACK_COMPONENTS, `Como mucho ${MAX_PACK_COMPONENTS} partes`)
  .refine((parts) => new Set(parts.map((p) => p.category)).size === parts.length, {
    message: 'Cada parte del pack va a una sección distinta',
  });

/** Por qué un pack no vale (null = vale). El servidor lo comprueba siempre. */
export function packProblem(
  priceCents: number,
  category: string,
  components: readonly PackComponent[] | null | undefined,
): string | null {
  if (!components || components.length === 0) return null;
  const sum = components.reduce((acc, c) => acc + c.amountCents, 0);
  if (sum !== priceCents) {
    return `Las partes del pack suman ${(sum / 100).toFixed(2).replace('.', ',')} € y el precio es ${(priceCents / 100)
      .toFixed(2)
      .replace('.', ',')} €: tienen que ser iguales.`;
  }
  if (!components.some((c) => c.category === category)) {
    return 'La sección del pack tiene que ser una de sus partes.';
  }
  return null;
}

/** Lo guardado (JSON o null) como lista de partes; algo raro → null (sin pack). */
export function packComponentsOf(raw: unknown): PackComponent[] | null {
  const parsed = PackComponentsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ─── Cómo pagó ────────────────────────────────────────────────────────

/**
 * Cómo pagó el cliente. Apple Pay y Google Pay llegan del banco como «pago
 * con el móvil» (sin distinguir cuál hasta confirmar los códigos con BBVA).
 */
export const CHARGE_METHODS = ['CARD', 'MOBILE_WALLET', 'POS', 'SALDO', 'CASH'] as const;
export type ChargeMethod = (typeof CHARGE_METHODS)[number];

export const CHARGE_METHOD_LABELS: Readonly<Record<ChargeMethod, string>> = {
  CARD: 'Tarjeta',
  MOBILE_WALLET: 'Apple Pay / Google Pay',
  POS: 'Datáfono',
  SALDO: 'Saldo',
  CASH: 'Efectivo',
};

// ─── Lista de cobros del panel (Cobros, ficha de la chica y del saldo) ──

export const CobrosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Lo que devolvió `nextCursor` (fecha e id del último). */
  cursor: z.string().max(200).optional(),
  operatorId: UuidSchema.optional(),
  /** Sección (o EXTRA para los antiguos sin sección). */
  category: z.enum(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA']).optional(),
  method: z.enum(CHARGE_METHODS).optional(),
  /** Código del saldo (K7Q-4M2, con o sin guion): sus cobros del saldo. */
  walletCode: z.string().trim().min(3).max(12).optional(),
  /** Código de confirmación o referencia bancaria (al menos 3: el código tiene 3, y «1» lo encontraría casi todo). */
  search: z.string().trim().min(3).max(128).optional(),
  walletId: UuidSchema.optional(),
  /** Las invitaciones a esta chica (cobradas por otra persona). */
  invitedOperatorId: UuidSchema.optional(),
  /** Noche del local (Noches): sus cobros. */
  nightId: UuidSchema.optional(),
  /**
   * Desde / hasta (instantes ISO, [from, to)): la ventana de una cifra del
   * mapa del dinero. Con noche, la parte común de las dos.
   */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
});
export type CobrosQuery = z.infer<typeof CobrosQuerySchema>;

/** Historial propio: la identidad y el local los fija la sesión, nunca la query. */
export const OwnCobrosQuerySchema = CobrosQuerySchema.pick({ limit: true, cursor: true }).strict();
export type OwnCobrosQuery = z.infer<typeof OwnCobrosQuerySchema>;

export interface CobroPerson {
  id: string;
  name: string;
  role: string;
}

export interface CobroRow {
  /** PAYMENT: cobro con tarjeta, móvil o datáfono (o recarga). SALDO: cobro del saldo del cliente. */
  kind: 'PAYMENT' | 'SALDO';
  id: string;
  ref: string | null;
  /** Código que ve el cliente; los cobros de saldo sin tarjeta no lo tienen. */
  confirmationCode?: string | null;
  createdAt: string;
  amountCents: number;
  tipCents: number;
  /**
   * «Comisión del servicio» que pagó el cliente encima (cobros con tarjeta y
   * recargas; los del saldo no la llevan). Opcional: API anterior (0).
   */
  serviceFeeCents?: number;
  currency: string;
  /** Estado del cobro (los del saldo: ACCEPTED, o REVERSED si se anuló el consumo). */
  status: string;
  /** Quién cobró (la chica, el camarero…). */
  person: CobroPerson | null;
  /** Una sección (o varias: «Varias»). Recargas: vacía. */
  sections: SectionAmount[];
  isTopUp: boolean;
  method: ChargeMethod | null;
  /** «Tarjeta ••4242», «Saldo K7Q-•••»… */
  methodLabel: string;
  /** Por dónde se autorizó: «QR», «Datáfono», «NFC», «PIN», «Face ID», «Personal» (null: no se sabe). */
  via?: string | null;
  /** Saldo con el que pagó (cobros del saldo) o que recargó (recargas). */
  wallet: { id: string; codeHint: string } | null;
  /** Lo que se vendió («2× Copa · Habitación»). */
  service: string | null;
  /** «Copa con invitación»: la chica invitada. */
  invited: CobroPerson | null;
  lines: ChargeLineView[];
  /** Solo los cobros con tarjeta: lo que hace falta para devolver o resolver. */
  payment: CobroPaymentDetail | null;
  /**
   * Cobro único cobrado dos veces: lo pagó el saldo y DESPUÉS el banco aprobó
   * también la tarjeta (esta fila, CANCELED). `refunded`: la pasarela lo
   * devolvió sola; si no, hay que devolverlo (también sale en Incidencias).
   * Null u omitido: no pasó.
   */
  paidTwice?: CobroPaidTwice | null;
}

export interface CobroPaidTwice {
  /** Lo que cobró el banco en la tarjeta (importe + propina del pedido). */
  amountCents: number;
  refunded: boolean;
}

export interface CobroPaymentDetail {
  availableAmountCents: number;
  provider: string | null;
  providerTxId: string | null;
  captureMethod: string | null;
  updatedAt: string;
  authCode: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  payMethodCode: string | null;
  authorizedAt: string | null;
  attempts: Array<{
    providerTxId: string;
    status: string;
    createdAt: string;
    amountCents: number | null;
    tipCents: number | null;
  }>;
  terminal: { externalId: string; label: string };
}

export interface CobrosPage {
  items: CobroRow[];
  nextCursor: string | null;
}

// ─── Ficha del saldo (panel) ──────────────────────────────────────────

export interface WalletFichaTopUp {
  /** Recarga con tarjeta (PAYMENT) o en efectivo (CASH). */
  kind: 'PAYMENT' | 'CASH';
  id: string;
  ref: string | null;
  at: string;
  /** El saldo cargado. Negativo: una recarga en efectivo anulada. */
  amountCents: number;
  /** Su «Comisión del servicio» (se cobró encima, no es saldo; negativa en una anulación). Opcional: API anterior. */
  serviceFeeCents?: number;
  method: ChargeMethod;
  methodLabel: string;
  /** Quién la cobró (o el datáfono de recepción). */
  by: CobroPerson | null;
  terminalLabel: string | null;
  venueName: string;
  status: string;
  note: string | null;
}

export interface WalletFichaRefund {
  id: string;
  at: string;
  amountCents: number;
  method: 'CARD' | 'CASH';
  status: string;
  by: CobroPerson | null;
  bankReference: string | null;
  venueName: string;
}

/** Una ficha NFC dada a este saldo (la que paga, o la bloqueada). */
export interface WalletFichaCard {
  id: string;
  /** Para reconocerla: el final del número de serie o el principio del código grabado. */
  label: string;
  /** ISSUED / ACTIVE (paga) o BLOCKED. */
  status: string;
  linkedAt: string | null;
}

export interface WalletFicha {
  wallet: {
    id: string;
    code: string | null;
    label: string | null;
    balanceCents: number;
    status: string;
    createdAt: string;
    homeVenueName: string;
    hasPin: boolean;
    hasCard: boolean;
    hasFaceId: boolean;
  };
  topUps: WalletFichaTopUp[];
  /** Lo que se gastó del saldo (cobros del saldo, también los anulados: status REVERSED). */
  consumptions: Array<CobroRow & { venueName: string }>;
  refunds: WalletFichaRefund[];
  /** Sus fichas NFC (las que pagan y las bloqueadas). */
  cards?: WalletFichaCard[];
}


/** Vista del historial del personal, sin datos de tarjeta ni referencias bancarias internas. */
export type OwnCobro = Pick<
  CobroRow,
  'kind' | 'id' | 'ref' | 'createdAt' | 'amountCents' | 'tipCents' | 'serviceFeeCents' | 'status' | 'methodLabel' | 'service' | 'isTopUp'
> & {
  via: string | null;
  invitedName: string | null;
  /** Lo devuelto (importe + propina) de un cobro con tarjeta devuelto del todo o en parte; si no, 0. */
  refundedCents: number;
  /**
   * Cobrado dos veces (CobroRow.paidTwice): la fila del cobro con tarjeta lo
   * dice, como en el panel. Opcional: el API anterior no lo trae (nada que decir).
   */
  paidTwice?: CobroPaidTwice | null;
};
export interface OwnCobrosPage {
  items: OwnCobro[];
  nextCursor: string | null;
  /**
   * La noche del local (la abierta, desde su Z; sin noche abierta, desde el
   * último cierre), para el total de «Esta noche». Solo en la primera página.
   */
  night?: { from: string; open: boolean } | null;
}

/**
 * Lo devuelto de un cobro (lo devolvible − lo que aún se puede devolver). Lo
 * devolvible: importe + propina y la «Comisión del servicio» de un pago
 * directo (la de una recarga no se devuelve).
 */
export function ownRefundedCents(
  row: Pick<CobroRow, 'status' | 'amountCents' | 'tipCents' | 'payment'> & Partial<Pick<CobroRow, 'serviceFeeCents' | 'isTopUp'>>,
): number {
  if (!row.payment || (row.status !== 'REFUNDED' && row.status !== 'PARTIALLY_REFUNDED')) return 0;
  const fee = row.isTopUp ? 0 : (row.serviceFeeCents ?? 0);
  return Math.max(0, row.amountCents + fee + row.tipCents - row.payment.availableAmountCents);
}
