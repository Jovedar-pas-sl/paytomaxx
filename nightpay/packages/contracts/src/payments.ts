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
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const ProviderSchema = z.enum(['WIPAY', 'PEANPE']);
export type Provider = z.infer<typeof ProviderSchema>;

export const CreatePaymentSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_00, 'Max 10.000,00 EUR'),
  terminalId: UuidSchema,
  currency: z.string().length(3).default('EUR'),
});
export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;

export const PaymentResponseSchema = z.object({
  id: UuidSchema,
  amountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  qrUrl: z.string().url(),
  qrExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export const RefundRequestSchema = z.object({
  paymentId: UuidSchema,
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

// Eventos WS (server → cliente)
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
