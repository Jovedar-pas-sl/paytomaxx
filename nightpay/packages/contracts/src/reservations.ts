import { z } from 'zod';

/**
 * Reservados con señal y enlaces de RRPP (apps/api/src/modules/reservations).
 *
 * Reglas del dueño (9 y 10-nov-2026):
 *  - la señal es el 30 % del paquete, se paga al reservar y NO se devuelve;
 *  - el 70 % restante, online antes de ir o al llegar;
 *  - paga uno todo; cada persona del grupo tiene su QR y gasta del paquete;
 *  - el cliente cambia la fecha una sola vez, avisando con 48 h;
 *  - la comisión del RRPP (su %) se gana con el paquete pagado entero.
 */

/** La señal: 30 % del paquete. */
export const RESERVATION_DEPOSIT_BPS = 3000;
/** Precio mínimo de un paquete (la señal tiene que ser menor que el total). */
export const RESERVATION_MIN_PRICE_CENTS = 1000;
export const RESERVATION_MAX_PRICE_CENTS = 1_000_000;
/** Tope del % del RRPP (50 %): su comisión nunca pasa del resto que se cobra. */
export const PROMOTER_MAX_BPS = 5000;

/** Señal de un precio, en céntimos enteros. */
export function reservationDepositCents(priceCents: number): number {
  return Math.round((priceCents * RESERVATION_DEPOSIT_BPS) / 10_000);
}

export const RESERVATION_STATUSES = ['PENDING', 'DEPOSIT_PAID', 'PAID', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'CLIENT_CANCELED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Cómo se dice cada estado en la app (español sencillo). */
export const RESERVATION_STATUS_TEXT: Record<ReservationStatus, string> = {
  PENDING: 'Sin pagar',
  DEPOSIT_PAID: 'Señal pagada',
  PAID: 'Pagado',
  ARRIVED: 'Ha llegado',
  NO_SHOW: 'No vino',
  CANCELED: 'Anulada',
  CLIENT_CANCELED: 'Anulada por el cliente',
};

/** Hora de apertura por defecto (20:00), en minutos desde las 00:00. */
export const DEFAULT_OPEN_MINUTE = 20 * 60;
/** Se reserva para esta misma noche hasta 2 h antes de abrir. */
export const SAME_NIGHT_CUTOFF_MS = 2 * 60 * 60 * 1000;

/** «22:30» → 1350 (null si no es una hora). */
export function openMinuteOf(text: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 1350 → «22:30». */
export function openTimeText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Lo que se cobra en efectivo del resto (con la «Comisión del servicio» de las recargas si está encendida). */
export interface ReservationCashQuote {
  amountCents: number;
  serviceFeeCents: number;
  totalCents: number;
  /** null: se puede cobrar en efectivo; si no, por qué no. */
  blocked: string | null;
}

export const ReservationCashSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_:-]{8,80}$/),
    /** La comisión del servicio que enseñó la pantalla (0 sin ella). */
    serviceFeeCents: z.number().int().min(0).max(RESERVATION_MAX_PRICE_CENTS),
  })
  .strict();

export const ReservationSettingsSchema = z
  .object({ enabled: z.boolean().optional(), openTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Pon la hora como 22:30').optional() })
  .strict();

export type ReservationKind = 'ITEMS' | 'CREDIT';
export type ReservationSource = 'WEB' | 'RRPP' | 'PANEL';
export type ReservationPayKind = 'DEPOSIT' | 'REST' | 'FULL';

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pon la fecha como AAAA-MM-DD');

export const PackageItemSchema = z.object({
  name: z.string().trim().min(1).max(40),
  qty: z.number().int().min(1).max(99),
});
export type PackageItem = z.infer<typeof PackageItemSchema>;

export const ReservationPackageInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Pon un nombre').max(60),
    kind: z.enum(['ITEMS', 'CREDIT']),
    priceCents: z.number().int().min(RESERVATION_MIN_PRICE_CENTS, 'El paquete vale al menos 10 €').max(RESERVATION_MAX_PRICE_CENTS),
    /** Solo en los de importe: lo que hay para consumir (hasta el precio). */
    creditCents: z.number().int().min(0).max(RESERVATION_MAX_PRICE_CENTS).default(0),
    /** Personas (entradas): un QR por persona. */
    entries: z.number().int().min(1).max(50),
    items: z.array(PackageItemSchema).max(12).default([]),
    description: z.string().trim().max(200).nullish(),
    maxPerNight: z.number().int().min(1).max(500).nullish(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => (d.kind === 'ITEMS' ? d.creditCents === 0 : d.creditCents > 0 && d.creditCents <= d.priceCents), {
    message: 'De cosas fijas: sin importe. De importe: entre 1 € y el precio del paquete.',
    path: ['creditCents'],
  })
  .refine((d) => d.kind === 'CREDIT' || d.items.length > 0, { message: 'Pon al menos una cosa del paquete', path: ['items'] });
export type ReservationPackageInput = z.infer<typeof ReservationPackageInputSchema>;

export const ReservationPackageActiveSchema = z.object({ active: z.boolean() }).strict();

export interface ReservationPackageView {
  id: string;
  name: string;
  kind: ReservationKind;
  priceCents: number;
  creditCents: number;
  depositCents: number;
  entries: number;
  items: PackageItem[];
  description: string | null;
  maxPerNight: number | null;
  active: boolean;
}

/** Reservar (la web, el enlace del RRPP o el panel). `key`: la del navegador o la app (doble toque = la misma). */
export const CreateReservationSchema = z
  .object({
    packageId: z.string().uuid(),
    nightDate: DaySchema,
    customerName: z.string().trim().min(2, 'Pon tu nombre').max(60),
    customerPhone: z.string().trim().min(6, 'Pon tu teléfono').max(32),
    notes: z.string().trim().max(200).nullish(),
    key: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict();
export type CreateReservationDto = z.infer<typeof CreateReservationSchema>;

export const ReservationPaySchema = z
  .object({
    kind: z.enum(['DEPOSIT', 'REST', 'FULL']),
    /** El cliente marcó «Entiendo que la señal no se devuelve». */
    acceptedNoRefund: z.literal(true),
  })
  .strict();

export const ReservationChangeDateSchema = z.object({ nightDate: DaySchema }).strict();
export const ReservationTableSchema = z.object({ tableLabel: z.string().trim().max(20).nullable() }).strict();
export const ReservationVenueCancelSchema = z.object({ reason: z.string().trim().min(2, 'Pon el motivo').max(200) }).strict();

/** Barra: cobrar un importe del saldo del grupo con el QR de una persona. */
export const ReservationChargeSchema = z
  .object({
    guestToken: z.string().trim().min(16).max(400),
    amountCents: z.number().int().min(1).max(RESERVATION_MAX_PRICE_CENTS),
    key: z.string().regex(/^[A-Za-z0-9_:-]{8,80}$/),
  })
  .strict();
/** Barra: servir una cosa del paquete con el QR de una persona. */
export const ReservationServeSchema = z
  .object({
    guestToken: z.string().trim().min(16).max(400),
    itemName: z.string().trim().min(1).max(40),
    qty: z.number().int().min(1).max(20),
    key: z.string().regex(/^[A-Za-z0-9_:-]{8,80}$/),
  })
  .strict();

export const PromoterCreateSchema = z
  .object({ userId: z.string().uuid(), commissionBps: z.number().int().min(0).max(PROMOTER_MAX_BPS) })
  .strict();
export const PromoterUpdateSchema = z
  .object({ commissionBps: z.number().int().min(0).max(PROMOTER_MAX_BPS).optional(), active: z.boolean().optional() })
  .strict();

export interface PromoterView {
  id: string;
  userId: string;
  name: string;
  commissionBps: number;
  active: boolean;
  url: string;
  /** Lo que ha vendido: reservados pagados enteros y su comisión. */
  soldCount: number;
  commissionCents: number;
}

export interface ReservationGuestView {
  id: string;
  seq: number;
  label: string | null;
  checkedIn: boolean;
  spentCents: number;
  items: Array<{ name: string; qty: number }>;
}

/** Una reserva para el panel y la puerta. */
export interface ReservationView {
  id: string;
  ref: string;
  status: ReservationStatus;
  statusText: string;
  nightDate: string;
  previousNightDate: string | null;
  dateChanged: boolean;
  packageName: string;
  kind: ReservationKind;
  priceCents: number;
  creditCents: number;
  depositCents: number;
  paidCents: number;
  pendingCents: number;
  entries: number;
  items: PackageItem[];
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  tableLabel: string | null;
  source: ReservationSource;
  soldBy: string;
  promoterName: string | null;
  /** Saldo del grupo ahora (null: aún sin saldo). */
  balanceCents: number | null;
  /** Lo que queda de cada cosa (paquetes de cosas fijas). */
  itemsLeft: Array<{ name: string; qty: number; left: number }>;
  guests: ReservationGuestView[];
  arrivedAt: string | null;
  /** «No vino» puesto solo (a las 12:00 del día siguiente). */
  noShowAuto: boolean;
  canceledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

/** «Señales de reservas»: aparte de las ventas hasta el día de la reserva. */
export interface ReservationAccounting {
  from: string;
  to: string;
  /** Pagos de reservas cobrados en el periodo (señales, restos y pagos enteros). */
  collectedCents: number;
  /** Pasado a venta en el periodo (llegadas y señales perdidas). */
  recognizedCents: number;
  /** Lo cobrado de reservas que aún no han llegado (deuda con el cliente, hoy). */
  outstandingCents: number;
  /** Comisión de RRPP ganada en el periodo. */
  promoterCommissionCents: number;
}
