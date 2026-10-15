import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  Provider,
  RefundInput,
  RefundResult,
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
 * Un aviso que dice "cobro aprobado". Antes de dar el pago por pagado hay
 * que probarlo con algo que el cliente no pueda falsificar.
 */
export interface ApprovalClaim {
  paymentId: string;
  /** Pedido/operación de la pasarela que dice el aviso. */
  providerTxId: string;
  /** El aviso tal cual se guardó en webhook_deliveries, ya parseado. */
  payload: Record<string, unknown>;
}

/**
 * Prueba de la aprobación, sacada de una fuente fiable: un aviso firmado por
 * el banco (Redsys, Cecabank) o una consulta a la API de la pasarela (Paytef).
 *  - confirmed: aprobado por este importe. `currency` ISO 4217 (null = la
 *    pasarela no la dice; solo se compara el importe).
 *  - rejected: la pasarela no lo da por aprobado, o no es de este cobro.
 *  - unverifiable: la pasarela no ofrece forma de comprobarlo (Peanpe).
 *  - unavailable: no se pudo consultar ahora (red, 5xx): se reintenta.
 */
export type ApprovalProof =
  | { kind: 'confirmed'; amountCents: number; currency: string | null }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'unavailable'; reason: string };

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

  /** Reembolsa total o parcialmente. Idempotente por `reference`. */
  refund(input: RefundInput): Promise<RefundResult>;

  /** Verifica HMAC del webhook + extrae event id + payment ref. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookVerifyResult;

  /** Mapea el payload del webhook a un evento FSM (o null si no aplica). */
  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null;

  /**
   * Comprueba un aviso de cobro aprobado sin fiarse de lo que dice el aviso:
   * firma del banco o consulta a la pasarela. El procesador de avisos solo
   * da el pago por pagado si devuelve `confirmed` y el importe cuadra.
   */
  proveApproval(claim: ApprovalClaim): Promise<ApprovalProof>;
}
