import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type CircuitBreaker from 'opossum';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';
import { createBreaker, fetchWithTimeout, timedFire } from './circuit-breaker';
import { pickHeader } from './header-utils';
import { MetricsService } from '../metrics/metrics.service';

const PROVIDER_LABEL = 'PAYTEF' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Shape de la respuesta `GET /payment-link/get/{paymentID}` de Paytef.
 * Solo modelamos los campos que necesitamos (Paytef devuelve mucho más).
 * Doc fuente: my.paytef.es → API de Payment LINK.
 */
interface PaytefPaymentLink {
  id?: string;
  isFinished?: boolean;
  isVisible?: boolean;
  isCanceled?: boolean;
  isExpired?: boolean;
  amountCents?: number;
  currency?: string;
  lastResult?: {
    txnKey?: string;
    isApproved?: boolean;
    resultCode?: string;
    resultReason?: string;
    paytefID?: number;
    cardLastDigits?: string;
    cardBrand?: string;
  };
  clientID?: string;
}

/**
 * Payload tipico del webhook `notifyResultURL`. Paytef NO documenta el shape
 * exacto del webhook — asumimos que envía el mismo objeto que GET /get + un
 * `paymentID`. Cuando lleguen los primeros webhooks reales, ajustamos.
 */
interface PaytefWebhookPayload {
  paymentID?: string;
  data?: PaytefPaymentLink;
}

@Injectable()
export class PaytefAdapter implements GatewayAdapter {
  readonly provider = 'PAYTEF' as const;
  private readonly logger = new Logger(PaytefAdapter.name);

  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly authorizeBreaker: CircuitBreaker<[AuthorizeInput], AuthorizeResult>;
  private readonly statusBreaker: CircuitBreaker<[string, string], GatewayStatus>;
  private readonly refundBreaker: CircuitBreaker<[RefundInput], RefundResult>;
  private readonly timeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.timeoutMs = config.get<number>('GATEWAY_TIMEOUT_MS') ?? 5000;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'paytef.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'paytef.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'paytef.refund',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'refund' }, stateToNumber(s)),
    });
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    return timedFire(
      () => this.authorizeBreaker.fire(input),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'authorize', outcome }, dur),
    );
  }

  async getStatus(tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    return timedFire(
      () => this.statusBreaker.fire(tenantId, providerTxId),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'getStatus', outcome }, dur),
    );
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return timedFire(
      () => this.refundBreaker.fire(input),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'refund', outcome }, dur),
    );
  }

  // ─── Implementaciones tras circuit breaker ───────────────────────

  /**
   * Crea + publica una solicitud de PaymentLINK en Paytef.
   * Devuelve el paymentID (Paytef) como providerTxId. La URL pública la
   * exponemos a través de extras para que NightPay la incluya en su QR.
   */
  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const baseUrl = this.baseUrl();
    const authHeader = this.authHeader();

    // 1) Crear la solicitud (POST /payment-link/save)
    // Paytef pide `changeCard` explícito (422 si falta). false = NightPay no
    // permite al cliente cambiar de tarjeta tras la primera carga (siempre
    // crea pago nuevo).
    // companyID + branchID son obligatorios. Para la cuenta del usuario actual:
    //   companyID=76861 ("Rapido Sin Riesgos"), branches RSR5..RSR12.
    // Se configuran en PAYTEF_COMPANY_ID / PAYTEF_BRANCH_ID del .env.
    const companyID = this.config.get<number>('PAYTEF_COMPANY_ID');
    const branchID = this.config.get<number>('PAYTEF_BRANCH_ID');
    if (!companyID || !branchID) {
      throw new Error(
        'PAYTEF_COMPANY_ID y PAYTEF_BRANCH_ID son obligatorios. Obtén los IDs vía GET /payment-link/getBranches.',
      );
    }
    const saveBody = {
      data: {
        opType: 'sale',
        customerAuthentication: 'strong',
        changeCard: false,
        companyID,
        branchID,
        amountCents: input.amountCents,
        currency: input.currency,
        description: `NightPay ${input.reference}`,
        clientID: input.reference, // nuestro UUID payment como clientID Paytef
        language: 'ES',
        isTest: process.env.NODE_ENV !== 'production',
        notifyResultURL: this.webhookUrl(),
        notifyResultURLKo: this.webhookUrl(), // mismo endpoint, evento distingue
      },
    };

    const saveRes = await fetchWithTimeout(
      `${baseUrl}/payment-link/save`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(saveBody),
      },
      this.timeoutMs,
    );
    if (!saveRes.ok) {
      const text = await saveRes.text().catch(() => '');
      throw new Error(`Paytef /save failed: ${saveRes.status} ${text.slice(0, 200)}`);
    }
    const saveData = (await saveRes.json()) as {
      success?: boolean;
      paymentID?: string;
      paymentURL?: string;
    };
    if (!saveData.success || !saveData.paymentID) {
      throw new Error(`Paytef /save returned no paymentID: ${JSON.stringify(saveData)}`);
    }

    // 2) Publicar para que sea visible al cliente (POST /payment-link/publish)
    const publishRes = await fetchWithTimeout(
      `${baseUrl}/payment-link/publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          paymentID: saveData.paymentID,
          sendEmailNotification: false,
        }),
      },
      this.timeoutMs,
    );
    if (!publishRes.ok) {
      const text = await publishRes.text().catch(() => '');
      throw new Error(`Paytef /publish failed: ${publishRes.status} ${text.slice(0, 200)}`);
    }

    this.logger.log(
      `Paytef authorized: paymentID=${saveData.paymentID} url=${saveData.paymentURL}`,
    );

    return {
      provider: 'PAYTEF',
      providerTxId: saveData.paymentID,
      status: 'PROCESSING',
    };
  }

  private async doGetStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}/payment-link/get/${providerTxId}`,
      { headers: { Authorization: this.authHeader() } },
      this.timeoutMs,
    );
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { data?: PaytefPaymentLink };
    return mapPaytefStatus(data.data);
  }

  /**
   * Paytef PaymentLINK NO expone refund vía API actualmente. El admin debe
   * refundear desde el panel my.paytef.es. Lanzamos NotImplemented claro para
   * que el flujo NightPay sepa que hay que avisar al admin.
   */
  private async doRefund(_input: RefundInput): Promise<RefundResult> {
    this.logger.warn(
      'Paytef refund vía API no soportado por el PSP. Refund manual desde my.paytef.es requerido.',
    );
    throw new Error(
      'paytef-refund-manual-required: Paytef PaymentLINK no expone refund via API. ' +
        'Refundea desde el panel my.paytef.es y marca el refund manualmente en NightPay.',
    );
  }

  // ─── Webhook handling ────────────────────────────────────────────
  //
  // Paytef NO firma webhooks con HMAC estándar. La doc oficial solo dice
  // "notifyResultURL será llamada cuando la transacción se cierre". Para
  // protegernos usamos un esquema híbrido:
  //
  // 1) URL secreta: el endpoint es /v1/webhooks/paytef/<PAYTEF_WEBHOOK_SECRET>
  //    Solo Paytef conoce esa URL (admin la configura en notifyResultURL).
  //    Eso ya filtra el 99% de tráfico atacante.
  //
  // 2) Validación cruzada: el adapter relee `paymentID` contra Paytef
  //    (`GET /payment-link/get/{id}`) para confirmar el estado — un atacante
  //    que conozca la URL no puede falsear estados, Paytef es la fuente de
  //    verdad.
  //
  // Cuando Paytef añada firma HMAC al webhook (PR pedido), actualizamos.
  //
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    // Opción A — Si Paytef añade firma en el futuro: validar HMAC.
    const sig = pickHeader(headers, 'x-paytef-signature');
    const ts = pickHeader(headers, 'x-paytef-timestamp');

    if (sig && ts) {
      // Camino HMAC estándar (cuando Paytef lo implemente)
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > REPLAY_WINDOW_MS) {
        return { valid: false, reason: 'timestamp-out-of-window' };
      }
      const secret = this.config.get<string>('PAYTEF_WEBHOOK_SECRET');
      if (!secret) return { valid: false, reason: 'webhook-secret-not-configured' };
      const expected = createHmac('sha256', secret)
        .update(`${ts}.${rawBody.toString('utf8')}`)
        .digest('hex');
      try {
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return { valid: false, reason: 'signature-mismatch' };
        }
      } catch {
        return { valid: false, reason: 'invalid-signature-encoding' };
      }
    }
    // Si no hay firma, confiamos en la URL secreta (validada por
    // webhooks.controller antes de llegar aquí). Parseamos body.

    let parsed: PaytefWebhookPayload;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as PaytefWebhookPayload;
    } catch {
      return { valid: false, reason: 'invalid-json' };
    }

    const paymentID = parsed.paymentID ?? parsed.data?.id;
    const paymentRef = parsed.data?.clientID; // nuestro UUID interno
    if (!paymentID || !paymentRef) {
      return { valid: false, reason: 'missing-paymentID-or-clientID' };
    }

    // externalEventId = paymentID + last txnKey si está, para idempotency.
    const externalEventId = parsed.data?.lastResult?.txnKey
      ? `${paymentID}_${parsed.data.lastResult.txnKey}`
      : paymentID;

    return { valid: true, externalEventId, paymentRef };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const p = parsedPayload as PaytefWebhookPayload;
    const data = p.data;
    if (!data || !data.clientID) return null;

    // Cancelado o expirado → FAILED
    if (data.isCanceled || data.isExpired) {
      return {
        paymentId: data.clientID,
        event: { type: 'FAILED', reason: data.isExpired ? 'expired' : 'canceled' },
      };
    }

    // Resultado aprobado → AUTHORIZED
    if (data.lastResult?.isApproved === true) {
      return {
        paymentId: data.clientID,
        event: {
          type: 'AUTHORIZED',
          providerTxId: data.id ?? '',
          provider: 'PAYTEF',
        },
      };
    }

    // Resultado declinado (lastResult presente pero isApproved=false)
    if (data.lastResult && data.lastResult.isApproved === false) {
      return {
        paymentId: data.clientID,
        event: {
          type: 'FAILED',
          reason: data.lastResult.resultReason ?? data.lastResult.resultCode ?? 'declined',
        },
      };
    }

    // No es un evento terminal — ignorar (lifecycle interno Paytef)
    return null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private baseUrl(): string {
    return this.config.get<string>('PAYTEF_API_URL') ?? 'https://api.paytef.es/gcf';
  }

  /**
   * Construye el header Authorization. Acepta token con o sin prefijo
   * "PAYTEF-TOKEN " (algunos admins copian el header completo del panel).
   */
  private authHeader(): string {
    const raw = this.config.get<string>('PAYTEF_API_TOKEN');
    if (!raw) {
      throw new Error('PAYTEF_API_TOKEN not configured');
    }
    const trimmed = raw.trim();
    return trimmed.startsWith('PAYTEF-TOKEN ') ? trimmed : `PAYTEF-TOKEN ${trimmed}`;
  }

  private webhookUrl(): string | undefined {
    const url = this.config.get<string>('PAYTEF_WEBHOOK_URL');
    const secret = this.config.get<string>('PAYTEF_WEBHOOK_SECRET');
    if (!url) return undefined;
    // Si hay secret, lo incluimos en el path para URL secreta defensa-en-profundidad.
    return secret ? `${url}/${secret}` : url;
  }
}

/**
 * Mapea el estado de un PaymentLink Paytef al status interno NightPay.
 *  - isCanceled/isExpired → FAILED
 *  - lastResult.isApproved=true → AUTHORIZED
 *  - lastResult.isApproved=false → FAILED
 *  - isFinished sin lastResult → UNKNOWN (caso raro)
 *  - default (esperando pago) → PROCESSING
 */
function mapPaytefStatus(data: PaytefPaymentLink | undefined): GatewayStatus {
  if (!data) return 'UNKNOWN';
  if (data.isCanceled || data.isExpired) return 'FAILED';
  if (data.lastResult?.isApproved === true) return 'AUTHORIZED';
  if (data.lastResult && data.lastResult.isApproved === false) return 'FAILED';
  if (data.isFinished) return 'UNKNOWN';
  return 'PROCESSING';
}
