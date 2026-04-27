import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  Provider,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { PaymentEvent } from '../payments/payment.machine';

/**
 * Evento FSM derivado de un webhook ya verificado.
 * `paymentId` es el ID interno NightPay (resuelto del paymentRef del webhook).
 */
export interface WebhookFsmEvent {
  paymentId: string;
  event: PaymentEvent;
}

/**
 * Interfaz común que toda pasarela debe implementar (ADR-005).
 * El módulo de pagos NUNCA importa clases concretas — solo esta interfaz.
 */
export interface GatewayAdapter {
  readonly provider: Provider;

  /** Inicia autorización en la pasarela. */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;

  /** Consulta estado actual (saga orphan-reconcile). */
  getStatus(tenantId: string, providerTxId: string): Promise<GatewayStatus>;

  /** Verifica HMAC del webhook + extrae event id + payment ref. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookVerifyResult;

  /** Mapea el payload del webhook a un evento FSM (o null si no aplica). */
  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null;
}
