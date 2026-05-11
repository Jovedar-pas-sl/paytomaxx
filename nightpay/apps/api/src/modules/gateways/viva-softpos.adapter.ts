import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  Provider,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';

/**
 * Viva.com Smart Checkout / Tap to Phone adapter (Phase 1C).
 *
 * Flujo SoftPOS (distinto a 3DS pasarela tradicional):
 *  1. Operadora pulsa "Cobrar contactless" en su app → POST /payments/softpos/initialize.
 *  2. PaymentsService crea Payment (CREATED) y llama `initializeOrder()` aquí.
 *  3. Devolvemos `orderCode` Viva al SDK móvil de la operadora.
 *  4. SDK móvil activa NFC reader, cliente acerca tarjeta, Viva procesa.
 *  5. Viva envía webhook → `verifyWebhook` → `mapWebhookToFsmEvent` → FSM AUTHORIZED.
 *
 * Si VIVA_API_KEY no está set → cualquier llamada lanza ServiceUnavailableException
 * y el endpoint /softpos/initialize devuelve 503 al frontend.
 */
@Injectable()
export class VivaSoftPosAdapter implements GatewayAdapter {
  public readonly provider: Provider = 'VIVA_SOFTPOS';
  private readonly logger = new Logger(VivaSoftPosAdapter.name);
  private readonly apiKey: string | undefined;
  private readonly merchantId: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly environment: 'sandbox' | 'production';

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('VIVA_API_KEY');
    this.merchantId = config.get<string>('VIVA_MERCHANT_ID');
    this.webhookSecret = config.get<string>('VIVA_WEBHOOK_SECRET');
    this.baseUrl = config.get<string>('VIVA_BASE_URL') ?? 'https://demo-api.vivapayments.com';
    this.environment = this.baseUrl.includes('demo-api') ? 'sandbox' : 'production';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.merchantId);
  }

  /**
   * Crea una orden Viva y devuelve el orderCode para iniciar el SDK móvil.
   * No es parte del interface GatewayAdapter porque SoftPOS no usa el flow
   * authorize() tradicional — el authorize lo hace el SDK contactless.
   */
  async initializeOrder(input: {
    paymentRef: string;
    amountCents: number;
    currency: string;
    description?: string;
  }): Promise<{ orderCode: string; environment: 'sandbox' | 'production' }> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Viva SoftPOS no configurado — falta VIVA_API_KEY y/o VIVA_MERCHANT_ID en env',
      );
    }

    // Viva REST API: POST /checkout/v2/orders
    // Auth: Bearer token (OAuth client credentials, simplificado a apiKey aquí)
    const url = `${this.baseUrl}/checkout/v2/orders`;
    const body = {
      amount: input.amountCents, // Viva espera cents
      customerTrns: input.description ?? `NightPay ${input.paymentRef.slice(0, 8)}`,
      merchantTrns: input.paymentRef, // refid interno
      sourceCode: 'Default',
      paymentTimeOut: 300, // 5 min
      preauth: false,
      allowRecurring: false,
      maxInstallments: 0,
      paymentNotification: true,
      currencyCode: this.mapCurrency(input.currency),
      // tags: ['nightpay', 'softpos'],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      this.logger.error(`Viva create order failed ${res.status}: ${txt.slice(0, 200)}`);
      throw new ServiceUnavailableException(`Viva error ${res.status}`);
    }
    const payload = (await res.json()) as { orderCode?: number };
    if (!payload.orderCode) {
      throw new ServiceUnavailableException('Viva orden sin orderCode');
    }
    return { orderCode: String(payload.orderCode), environment: this.environment };
  }

  // Viva usa códigos ISO numéricos (978 = EUR). Mapeo mínimo.
  private mapCurrency(code: string): string {
    if (code.toUpperCase() === 'EUR') return '978';
    if (code.toUpperCase() === 'USD') return '840';
    return '978';
  }

  // ─── GatewayAdapter interface ─────────────────────────────────────

  // SoftPOS no usa authorize tradicional — el SDK móvil maneja el contactless.
  // Si alguien llama esto por error, devolvemos NOT_SUPPORTED.
  async authorize(_input: AuthorizeInput): Promise<AuthorizeResult> {
    throw new ServiceUnavailableException(
      'VIVA_SOFTPOS no soporta authorize() vía API — usar /payments/softpos/initialize',
    );
  }

  async getStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    if (!this.isConfigured()) {
      return { state: 'UNKNOWN', providerTxId, providerStatus: 'not_configured' };
    }
    try {
      const url = `${this.baseUrl}/checkout/v2/transactions/${providerTxId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { state: 'UNKNOWN', providerTxId, providerStatus: `viva_${res.status}` };
      const body = (await res.json()) as { statusId?: string; amount?: number };
      // Viva statusId: 'F' = finalizado/charged, 'X' = cancelado/failed, 'A' = activo/pending
      const map: Record<string, GatewayStatus['state']> = {
        F: 'AUTHORIZED',
        X: 'FAILED',
        A: 'PENDING',
      };
      return {
        state: map[body.statusId ?? 'A'] ?? 'UNKNOWN',
        providerTxId,
        providerStatus: body.statusId ?? 'unknown',
      };
    } catch (err) {
      this.logger.warn(`Viva getStatus exception: ${(err as Error).message}`);
      return { state: 'UNKNOWN', providerTxId, providerStatus: 'exception' };
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('Viva no configurado');
    }
    // Viva refund: DELETE /checkout/v2/transactions/{id}?amount=...
    const url = `${this.baseUrl}/checkout/v2/transactions/${input.providerTxId}?amount=${input.amountCents}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new ServiceUnavailableException(`Viva refund ${res.status}: ${txt.slice(0, 100)}`);
    }
    const body = (await res.json()) as { transactionId?: string };
    return {
      providerRefundId: body.transactionId ?? `viva-refund-${Date.now()}`,
      status: 'SUCCEEDED',
    };
  }

  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    if (!this.webhookSecret) {
      return { valid: false, reason: 'webhook_secret_not_configured' };
    }
    // Viva firma webhooks con header `Authorization: Basic base64(merchant:apiKey)`
    // o, en modo nuevo, con HMAC-SHA256 sobre el body. Implementamos HMAC (más seguro).
    const sigRaw = headers['x-viva-signature'] ?? headers['X-Viva-Signature'];
    const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
    if (!sig) return { valid: false, reason: 'missing_signature' };

    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    try {
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { valid: false, reason: 'signature_mismatch' };
      }
    } catch {
      return { valid: false, reason: 'signature_format_error' };
    }
    return { valid: true };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // Viva envía un object {EventTypeId, EventData: {...}} — EventTypeId 1796 = Transaction Payment Created
    const p = parsedPayload as
      | {
          EventTypeId?: number;
          EventData?: {
            MerchantTrns?: string;
            TransactionId?: string;
            Amount?: number;
            StatusId?: string;
          };
        }
      | null;
    if (!p?.EventData) return null;
    const paymentRef = p.EventData.MerchantTrns; // este es el Payment.id que pasamos como merchantTrns
    const providerTxId = p.EventData.TransactionId;
    if (!paymentRef || !providerTxId) return null;

    // Status mapping
    const status = p.EventData.StatusId ?? 'A';
    if (status === 'F') {
      return {
        paymentId: paymentRef,
        event: { type: 'AUTHORIZED', providerTxId, providerData: { source: 'viva_softpos' } },
      };
    }
    if (status === 'X') {
      return {
        paymentId: paymentRef,
        event: { type: 'FAILED', reason: 'viva_softpos_declined', providerData: { source: 'viva_softpos' } },
      };
    }
    return null; // estados intermedios no se procesan
  }
}
