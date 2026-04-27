import { z } from 'zod';
import { ProviderSchema } from './payments';

/**
 * Resultado de verificación de webhook (HMAC + parsing).
 */
export const WebhookVerifyResultSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
  externalEventId: z.string().optional(),
  paymentRef: z.string().optional().describe('Referencia interna del pago (paymentId o qrToken)'),
});
export type WebhookVerifyResult = z.infer<typeof WebhookVerifyResultSchema>;

/**
 * Status genérico devuelto por un getStatus a la pasarela.
 */
export const GatewayStatusSchema = z.enum(['AUTHORIZED', 'FAILED', 'PROCESSING', 'UNKNOWN']);
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

/**
 * Input/output normalizados de la pasarela — abstracción del adapter.
 */
export const AuthorizeInputSchema = z.object({
  tenantId: z.string().uuid(),
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  terminalExternalId: z.string(),
  reference: z.string(),
});
export type AuthorizeInput = z.infer<typeof AuthorizeInputSchema>;

export const AuthorizeResultSchema = z.object({
  provider: ProviderSchema,
  providerTxId: z.string(),
  status: GatewayStatusSchema,
});
export type AuthorizeResult = z.infer<typeof AuthorizeResultSchema>;
