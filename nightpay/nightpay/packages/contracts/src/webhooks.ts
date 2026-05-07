import { z } from 'zod';
import { UuidSchema } from './common';

export const WebhookEventTypeSchema = z.enum([
  'payment.authorized',
  'payment.failed',
  'payment.voided',
  'refund.succeeded',
  'refund.failed',
]);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export const WipayWebhookPayloadSchema = z.object({
  event_id: z.string(),
  event_type: WebhookEventTypeSchema,
  transaction_id: z.string(),
  reference: z.string(),
  merchant_id: z.string(),
  amount: z.number().int(),
  currency: z.string().length(3),
  timestamp: z.number().int(),
});
export type WipayWebhookPayload = z.infer<typeof WipayWebhookPayloadSchema>;

export const PeanpeWebhookPayloadSchema = z.object({
  id: z.string(),
  type: WebhookEventTypeSchema,
  providerTxId: z.string(),
  externalRef: z.string(),
  venueId: UuidSchema,
  amountCents: z.number().int(),
  ts: z.string().datetime(),
});
export type PeanpeWebhookPayload = z.infer<typeof PeanpeWebhookPayloadSchema>;

// WebhookVerifyResult vive en gateways.ts — el adapter es quien lo emite.
