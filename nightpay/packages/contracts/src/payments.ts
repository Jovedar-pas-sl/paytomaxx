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

export const ProviderSchema = z.enum(['WIPAY', 'PEANPE']);
export type Provider = z.infer<typeof ProviderSchema>;

// ─── Crear pago (TPV → API) ──────────────────────────────────────────
export const CreatePaymentSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_00, 'Max 10.000,00 EUR'),
  terminalExternalId: z
    .string()
    .min(1)
    .max(80)
    .describe('externalId del terminal del venue (ej. BARRA-1)'),
  currency: z.string().length(3).default('EUR'),
});
export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;

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
