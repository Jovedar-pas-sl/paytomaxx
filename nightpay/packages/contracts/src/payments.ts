import { z } from 'zod';
import { UuidSchema } from './common';

export const PaymentStatusSchema = z.enum([
  'CREATED',
  'AWAITING_CAPTURE',
  'AUTHORIZING',
  'AUTHORIZED',
  'FAILED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ORPHAN',
  'CANCELED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const ProviderSchema = z.enum(['WIPAY', 'PEANPE', 'PAYTEF', 'REDSYS']);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Zonas físicas del venue para routing del PAX (Track A POS_EXTERNAL).
 *  - BARRA: barra del bar
 *  - HABITACIONES: habitaciones del hospedaje
 *  - MESAS: mesas del salón
 *  - OTRO: zona personalizada (requiere `zoneCustom` con el nombre real)
 *
 * Backward compat: payments antiguos pueden no tener zone (terminalExternalId
 * directo). Si Terminal.zone existe, predomina routing por zona.
 */
export const TerminalZoneSchema = z.enum(['BARRA', 'HABITACIONES', 'MESAS', 'OTRO']);
export type TerminalZone = z.infer<typeof TerminalZoneSchema>;

// ─── Crear pago (TPV → API) ──────────────────────────────────────────

/**
 * Modo de captura del cobro:
 * - QR: cliente escanea QR con su móvil, paga via PSP de NightPay (default).
 * - WALLET_TOPUP: top-up de un ClientWallet (Phase 1B).
 * - POS_EXTERNAL: la chica crea el cobro pero el cliente paga en el datáfono
 *   del bar (Redsys/SumUp/etc., NO el PSP de NightPay). El camarero confirma
 *   manualmente tras procesar la tarjeta en el datáfono. NightPay solo
 *   tracking + comisión chica.
 */
export const CaptureMethodSchema = z.enum(['QR', 'WALLET_TOPUP', 'POS_EXTERNAL']);
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>;

/**
 * Destino de la propina. 'operator' = chica que creó el cobro; 'venue' = local;
 * 'shared' = pool (futuro); 'beneficiary' = userId explícito (campo tipBeneficiaryUserId).
 */
export const TipGoesToSchema = z.enum(['operator', 'venue', 'shared', 'beneficiary']);
export type TipGoesTo = z.infer<typeof TipGoesToSchema>;

/**
 * Categoría contable del cobro. Determina (a) si va a earnings de la chica
 * creator y a qué bps, y (b) cómo se agrega en el Z-report.
 *
 *  CHICA_SERVICE → servicio profesional de la chica (tiempo, compañía).
 *                  Usa User.commissionBps (override) o Venue.operatorCommissionDefaults.CHICA_SERVICE.
 *                  Default venue: 9000 bps = 90% para la chica.
 *  VENUE_BAR     → bebidas vendidas por el local. Default venue: 0% (es ingreso local).
 *  VENUE_ROOM    → alquiler de habitación. Default venue: 0%.
 *  VENUE_FOOD    → comida vendida por el local. Default venue: 0%.
 *  EXTRA         → otros / mixto. Default venue: 0%.
 *
 * Cada venue puede ajustar los % en cada categoría desde admin → Settings.
 */
export const RevenueCategorySchema = z.enum([
  'CHICA_SERVICE',
  'VENUE_BAR',
  'VENUE_ROOM',
  'VENUE_FOOD',
  'EXTRA',
]);
export type RevenueCategory = z.infer<typeof RevenueCategorySchema>;

/**
 * Mapa de comisiones por categoría en bps. Almacenado en Venue.operatorCommissionDefaults.
 * Todas las categorías son required en el shape para evitar ambigüedad de defaults.
 */
export const OperatorCommissionDefaultsSchema = z.object({
  CHICA_SERVICE: z.number().int().min(0).max(10000),
  VENUE_BAR: z.number().int().min(0).max(10000),
  VENUE_ROOM: z.number().int().min(0).max(10000),
  VENUE_FOOD: z.number().int().min(0).max(10000),
  EXTRA: z.number().int().min(0).max(10000),
});
export type OperatorCommissionDefaults = z.infer<typeof OperatorCommissionDefaultsSchema>;

export const CreatePaymentSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_00, 'Max 10.000,00 EUR'),
  /**
   * externalId del terminal específico (ej. "BARRA-1"). Opcional cuando se
   * pasa `zone` — el backend resuelve un terminal de esa zona automáticamente.
   * Si se pasan los dos, terminalExternalId tiene preferencia.
   */
  terminalExternalId: z.string().min(1).max(80).optional(),
  /**
   * Track A — Routing por zona física (cuando el venue tiene 6-8 PAX por zona).
   * Si zone=OTRO, también requiere `zoneCustom` con el nombre real.
   * Si solo se pasa `zone`, el backend resuelve un terminal activo de esa zona.
   */
  zone: TerminalZoneSchema.optional(),
  zoneCustom: z.string().min(1).max(40).optional(),
  currency: z.string().length(3).default('EUR'),
  /**
   * Phase 1B opcional — si presente, este pago es un top-up de ClientWallet.
   * - create: true → crea una wallet nueva, walletId queda en la response.
   * - walletId: <uuid> → suma al balance de una wallet existente al AUTHORIZED.
   * (Mutex con captureMethod=POS_EXTERNAL: no se puede top-upear via POS.)
   */
  wallet: z
    .union([
      z.object({
        create: z.literal(true),
        identifier: z.string().min(1).max(200).optional(),
      }),
      z.object({
        walletId: UuidSchema,
      }),
    ])
    .optional(),
  /**
   * POS_EXTERNAL: la chica crea el cobro, el camarero procesa la tarjeta en
   * el datáfono del bar, después confirma en NightPay. No hay PSP roundtrip.
   */
  captureMethod: CaptureMethodSchema.optional(),
  /**
   * Propina opcional. Si tipCents > 0:
   *  - el importe se suma al cargo en tarjeta (cliente paga amount + tip).
   *  - se asigna según tipGoesTo (default 'operator' si el creator es OPERATOR).
   *  - tipBeneficiaryUserId override cuando tipGoesTo='beneficiary'.
   */
  tipCents: z.number().int().nonnegative().max(5_000_00, 'Tip máx 5.000,00 EUR').optional(),
  tipGoesTo: TipGoesToSchema.optional(),
  tipBeneficiaryUserId: UuidSchema.optional(),
  /**
   * Categoría de ingreso. Determina si va a comisión chica y a qué %.
   * Si se omite, el backend infiere por defecto:
   *   - creator OPERATOR + sin wallet → CHICA_SERVICE
   *   - creator WAITER/MANAGER/OWNER → EXTRA (admin/camarero debe elegir)
   */
  revenueCategory: RevenueCategorySchema.optional(),
  /**
   * Fase 1A — servicio de la carta del local. Si viene, el servidor usa SU
   * precio y SU categoría (amountCents y revenueCategory del cliente se ignoran).
   */
  serviceItemId: UuidSchema.optional(),
}).refine(
  (d) => d.terminalExternalId !== undefined || d.zone !== undefined,
  { message: 'Debes pasar terminalExternalId o zone' },
).refine(
  (d) => d.zone !== 'OTRO' || (d.zoneCustom !== undefined && d.zoneCustom.length > 0),
  { message: 'zoneCustom obligatorio cuando zone=OTRO' },
);
export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;

/**
 * Confirmación POS — camarero/manager marca cobrado tras procesar la tarjeta
 * en el datáfono externo.
 *
 * `posReceiptRef` es el CÓDIGO DE AUTORIZACIÓN del ticket del datáfono
 * (6 letras o números, "AUT" / "Nº autorización"). Antes valía cualquier
 * texto de 3 caracteres; ahora se valida el formato y el servidor rechaza
 * un código ya usado en el mismo terminal (Fase 0).
 *
 * `posReceiptPhoto`: data URL del ticket fotografiado por el camarero. Opcional
 * pero recomendado en disputes. Tamaño máx 500KB para evitar payloads enormes.
 */
export const ConfirmPosPaymentSchema = z.object({
  posReceiptRef: z
    .string()
    .transform((s) => s.replace(/\s+/g, '').toUpperCase())
    .pipe(
      z
        .string()
        .regex(/^[A-Z0-9]{6}$/, 'Teclea el código de autorización del ticket: 6 letras o números'),
    ),
  posReceiptPhoto: z
    .string()
    .startsWith('data:image/')
    .max(500_000, 'Foto máx 500KB — comprime antes de subir')
    .optional(),
  notes: z.string().max(500).optional(),
});
export type ConfirmPosPaymentDto = z.infer<typeof ConfirmPosPaymentSchema>;

// ─── Respuesta de creación (TPV recibe esto) ─────────────────────────
export const CreatedPaymentResponseSchema = z.object({
  id: UuidSchema,
  amountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  qrToken: z.string(),
  qrUrl: z.string().url().describe('URL completa que va dentro del QR'),
  qrPngDataUrl: z
    .string()
    .startsWith('data:image/png;base64,')
    .describe('PNG del QR ya renderizado, embebido como data URL'),
  qrExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  /**
   * Phase 1B — solo cuando el pago es un top-up de wallet (dto.wallet set).
   * El cliente usa walletQrToken para ver su saldo + consumir.
   */
  walletId: UuidSchema.nullable().optional(),
  walletQrToken: z.string().nullable().optional(),
});
export type CreatedPaymentResponse = z.infer<typeof CreatedPaymentResponseSchema>;

// ─── Lookup público por QR token (cliente escanea) ───────────────────
export const PublicPaymentViewSchema = z.object({
  id: UuidSchema,
  amountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  venueName: z.string(),
  terminalLabel: z.string(),
  qrExpiresAt: z.string().datetime(),
});
export type PublicPaymentView = z.infer<typeof PublicPaymentViewSchema>;

// ─── Detalle interno (admin ve esto) ─────────────────────────────────
export const PaymentDetailSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  terminalId: UuidSchema,
  amountCents: z.number().int(),
  availableAmountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  provider: ProviderSchema.nullable(),
  providerTxId: z.string().nullable(),
  createdByUserId: UuidSchema.nullable(),
  createdByName: z.string().nullable(),
  qrExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;

// ─── Refund ──────────────────────────────────────────────────────────
export const RefundRequestSchema = z.object({
  paymentId: UuidSchema,
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

// ─── WS events (server → client) ─────────────────────────────────────
export const PaymentUpdateEventSchema = z.object({
  type: z.literal('payment:update'),
  paymentId: UuidSchema,
  status: PaymentStatusSchema,
  amountCents: z.number().int(),
  timestamp: z.string().datetime(),
});
export type PaymentUpdateEvent = z.infer<typeof PaymentUpdateEventSchema>;

export const PaymentCompletedEventSchema = z.object({
  type: z.literal('payment:completed'),
  paymentId: UuidSchema,
  status: z.enum(['AUTHORIZED', 'FAILED', 'EXPIRED']),
  timestamp: z.string().datetime(),
});
export type PaymentCompletedEvent = z.infer<typeof PaymentCompletedEventSchema>;

export const WsEventSchema = z.discriminatedUnion('type', [
  PaymentUpdateEventSchema,
  PaymentCompletedEventSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

// ─── FSM event types (transición interna) ───────────────────────────
export const FsmEventTypeSchema = z.enum([
  'QR_VIEWED',
  'AUTHORIZING',
  'AUTHORIZED',
  'FAILED',
  'TIMEOUT',
  'REFUND_PARTIAL',
  'REFUND_FULL',
  'CANCELED',
]);
export type FsmEventType = z.infer<typeof FsmEventTypeSchema>;
