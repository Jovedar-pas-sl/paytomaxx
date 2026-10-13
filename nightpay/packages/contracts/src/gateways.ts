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
  /** Botón que pulsó el cliente (Fase 1B). Sin él, la pasarela ofrece todo. */
  payMethod: z.enum(['wallet', 'card']).optional(),
  /** Idioma de la página del banco. */
  language: z.enum(['es', 'en']).optional(),
});
export type AuthorizeInput = z.infer<typeof AuthorizeInputSchema>;

export const AuthorizeResultSchema = z.object({
  provider: ProviderSchema,
  providerTxId: z.string(),
  status: GatewayStatusSchema,
  /**
   * URL al checkout/payment-link del PSP. Cuando el provider hospeda la página
   * de pago (Paytef Payment LINK, Stripe Checkout, etc.) NightPay redirige
   * al cliente aquí. Null para providers que no usan hosted checkout.
   */
  paymentLinkUrl: z.string().url().optional(),
  /**
   * Formulario auto-submit para PSPs que esperan POST desde browser del cliente
   * (Cecabank/Wipay TPV Virtual, Redsys, etc.) en vez de redirect a URL.
   *
   * NightPay renderiza un <form action method=POST> con esos `fields` ocultos
   * + auto-submit JS. El cliente acaba en la página hospedada del PSP donde
   * introduce los datos de tarjeta.
   */
  checkoutForm: z
    .object({
      action: z.string().url(),
      method: z.literal('POST'),
      fields: z.record(z.string()),
    })
    .optional(),
});
export type AuthorizeResult = z.infer<typeof AuthorizeResultSchema>;

export const RefundInputSchema = z.object({
  tenantId: z.string().uuid(),
  paymentId: z.string().uuid(),
  providerTxId: z.string(),
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  reference: z.string().describe('id interno del refund, sirve como idempotency key en pasarela'),
});
export type RefundInput = z.infer<typeof RefundInputSchema>;

export const RefundResultSchema = z.object({
  providerRefundId: z.string(),
  status: z.enum(['SUCCEEDED', 'PENDING', 'FAILED']),
});
export type RefundResult = z.infer<typeof RefundResultSchema>;
