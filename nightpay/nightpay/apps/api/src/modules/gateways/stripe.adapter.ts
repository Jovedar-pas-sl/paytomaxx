import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
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
import { createBreaker, timedFire } from './circuit-breaker';
import { pickHeader } from './header-utils';
import { MetricsService } from '../metrics/metrics.service';

const PROVIDER_LABEL = 'STRIPE' as const;

function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

@Injectable()
export class StripeAdapter implements GatewayAdapter {
  readonly provider = 'STRIPE' as const;

  private readonly logger = new Logger(StripeAdapter.name);
  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly stripe: Stripe | null;
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

    const apiKey = config.get<string>('STRIPE_API_KEY');
    this.stripe = apiKey
      ? new Stripe(apiKey, {
          // pin a la API version vigente al implementar — Stripe rechaza requests
          // sin esta cabecera implícita y cambiar de version sin querer rompe parsers.
          apiVersion: '2024-09-30.acacia',
          maxNetworkRetries: 0, // dejamos los retries al circuit breaker
          timeout: this.timeoutMs,
        })
      : null;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'stripe.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'stripe.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'stripe.refund',
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

  // ─── implementaciones ─────────────────────────────────────────────

  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const stripe = this.requireClient();
    const intent = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        // Para demo: dejamos a Stripe elegir métodos automáticamente
        // (tarjeta + wallets disponibles en la cuenta).
        automatic_payment_methods: { enabled: true },
        metadata: {
          nightpay_payment_id: input.paymentId,
          nightpay_tenant_id: input.tenantId,
          nightpay_reference: input.reference,
        },
      },
      { idempotencyKey: `auth-${input.reference}` },
    );

    if (!intent.client_secret) {
      throw new Error('Stripe authorize: missing client_secret');
    }

    return {
      provider: 'STRIPE',
      providerTxId: intent.id,
      status: 'PROCESSING',
      metadata: {
        clientSecret: intent.client_secret,
      },
    };
  }

  private async doGetStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const stripe = this.requireClient();
    try {
      const intent = await stripe.paymentIntents.retrieve(providerTxId);
      return mapStripeStatus(intent.status);
    } catch (err) {
      this.logger.warn(`stripe getStatus failed for ${providerTxId}: ${(err as Error).message}`);
      return 'UNKNOWN';
    }
  }

  private async doRefund(input: RefundInput): Promise<RefundResult> {
    const stripe = this.requireClient();
    const refund = await stripe.refunds.create(
      {
        payment_intent: input.providerTxId,
        amount: input.amountCents,
        ...(input.reason ? { reason: 'requested_by_customer' as const, metadata: { reason: input.reason } } : {}),
      },
      { idempotencyKey: input.reference },
    );

    return {
      providerRefundId: refund.id,
      status: mapStripeRefundStatus(refund.status),
    };
  }

  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    const stripe = this.requireClient();
    const signature = pickHeader(headers, 'stripe-signature');
    if (!signature) return { valid: false, reason: 'missing-stripe-signature' };

    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) return { valid: false, reason: 'webhook-secret-not-configured' };

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      return { valid: false, reason: `signature-verification-failed: ${(err as Error).message}` };
    }

    // Resolver paymentRef interno desde el metadata del PaymentIntent (o Refund).
    const paymentRef = extractNightPayPaymentId(event);
    if (!paymentRef) {
      return { valid: false, reason: 'missing-nightpay_payment_id-in-metadata' };
    }

    return {
      valid: true,
      externalEventId: event.id,
      paymentRef,
    };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // Stripe NO envía el evento como JSON parseado al adapter — lo recibimos como
    // raw buffer en verifyWebhook y reconstruimos el Stripe.Event ahí. Aquí
    // recibimos el body parseado por el caller (webhooks.controller). Lo casteamos
    // y miramos type + data.object.
    const event = parsedPayload as { type?: string; data?: { object?: Record<string, unknown> } };
    if (!event.type || !event.data?.object) return null;

    const obj = event.data.object;
    const paymentId = readString(obj.metadata, 'nightpay_payment_id');
    if (!paymentId) return null;

    if (event.type === 'payment_intent.succeeded') {
      const id = readString(obj, 'id');
      if (!id) return null;
      return {
        paymentId,
        event: { type: 'AUTHORIZED', providerTxId: id, provider: 'STRIPE' },
      };
    }

    if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
      return {
        paymentId,
        event: {
          type: 'FAILED',
          reason: readString(obj, 'last_payment_error.message') ?? event.type,
        },
      };
    }

    // charge.refunded y demás los manejamos por el flujo separado de refund —
    // no transicionan el pago vía webhook.
    return null;
  }

  private requireClient(): Stripe {
    if (!this.stripe) {
      throw new Error('STRIPE_API_KEY no está configurado en el entorno');
    }
    return this.stripe;
  }
}

function mapStripeStatus(s: Stripe.PaymentIntent.Status): GatewayStatus {
  switch (s) {
    case 'succeeded':
      return 'AUTHORIZED';
    case 'canceled':
      return 'FAILED';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'requires_capture':
    case 'processing':
      return 'PROCESSING';
    default:
      return 'UNKNOWN';
  }
}

function mapStripeRefundStatus(s: Stripe.Refund.Status | null): RefundResult['status'] {
  switch (s) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'pending':
    case 'requires_action':
      return 'PENDING';
    case 'failed':
    case 'canceled':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function readString(obj: unknown, path: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : null;
}

function extractNightPayPaymentId(event: Stripe.Event): string | null {
  // Eventos de PaymentIntent: data.object.metadata.nightpay_payment_id
  // Eventos de charge.refunded: data.object.payment_intent.metadata (a veces) — nos centramos en PI.
  const obj = event.data.object as Record<string, unknown>;
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const direct = metadata && typeof metadata.nightpay_payment_id === 'string'
    ? metadata.nightpay_payment_id
    : null;
  if (direct) return direct;
  return null;
}
