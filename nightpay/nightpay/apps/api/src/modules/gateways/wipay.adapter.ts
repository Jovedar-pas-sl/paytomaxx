import { Inject, Injectable } from '@nestjs/common';
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

const PROVIDER_LABEL = 'WIPAY' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

interface WipayWebhook {
  event_id?: string;
  event_type?: string;
  transaction_id?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  timestamp?: number;
}

@Injectable()
export class WipayAdapter implements GatewayAdapter {
  readonly provider = 'WIPAY' as const;

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
      name: 'wipay.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'wipay.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'wipay.refund',
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

  // ─── implementaciones tras el circuit breaker ─────────────────────

  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const url = `${this.baseUrl()}/v1/authorize`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: input.reference,
          amount: input.amountCents,
          currency: input.currency,
          terminal: input.terminalExternalId,
        }),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Wipay authorize failed: ${res.status}`);
    }
    const data = (await res.json()) as { transaction_id?: string };
    if (!data.transaction_id) {
      throw new Error('Wipay authorize: missing transaction_id');
    }
    return {
      provider: 'WIPAY',
      providerTxId: data.transaction_id,
      status: 'PROCESSING',
    };
  }

  private async doGetStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}/v1/transactions/${providerTxId}`,
      {},
      this.timeoutMs,
    );
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { status?: string };
    return mapWipayStatus(data.status);
  }

  private async doRefund(input: RefundInput): Promise<RefundResult> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}/v1/transactions/${input.providerTxId}/refund`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.reference,
        },
        body: JSON.stringify({
          amount: input.amountCents,
          reason: input.reason ?? '',
        }),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Wipay refund failed: ${res.status}`);
    }
    const data = (await res.json()) as { refund_id?: string; status?: string };
    if (!data.refund_id) {
      throw new Error('Wipay refund: missing refund_id');
    }
    return {
      providerRefundId: data.refund_id,
      status: data.status?.toUpperCase() === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
    };
  }

  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    const sig = pickHeader(headers, 'x-signature');
    const ts = pickHeader(headers, 'x-timestamp');
    if (!sig || !ts) return { valid: false, reason: 'missing-signature-or-timestamp' };

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > REPLAY_WINDOW_MS) {
      return { valid: false, reason: 'timestamp-out-of-window' };
    }

    const secret = this.config.getOrThrow<string>('WIPAY_WEBHOOK_SECRET');
    const expected = createHmac('sha256', secret)
      .update(`${ts}.${rawBody.toString('utf8')}`)
      .digest('hex');

    let valid = false;
    try {
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      valid = a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return { valid: false, reason: 'invalid-signature-encoding' };
    }
    if (!valid) return { valid: false, reason: 'signature-mismatch' };

    let parsed: WipayWebhook;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as WipayWebhook;
    } catch {
      return { valid: false, reason: 'invalid-json' };
    }
    if (!parsed.event_id || !parsed.reference) {
      return { valid: false, reason: 'missing-event-id-or-reference' };
    }
    return { valid: true, externalEventId: parsed.event_id, paymentRef: parsed.reference };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const p = parsedPayload as WipayWebhook;
    if (!p.reference || !p.transaction_id) return null;

    if (p.event_type === 'payment.authorized') {
      return {
        paymentId: p.reference,
        event: { type: 'AUTHORIZED', providerTxId: p.transaction_id, provider: 'WIPAY' },
      };
    }
    if (p.event_type === 'payment.failed' || p.event_type === 'payment.voided') {
      return {
        paymentId: p.reference,
        event: { type: 'FAILED', reason: p.event_type },
      };
    }
    return null;
  }

  private baseUrl(): string {
    return this.config.getOrThrow<string>('WIPAY_API_URL');
  }
}

function mapWipayStatus(s: string | undefined): GatewayStatus {
  switch ((s ?? '').toUpperCase()) {
    case 'AUTHORIZED':
      return 'AUTHORIZED';
    case 'FAILED':
    case 'VOIDED':
      return 'FAILED';
    case 'PROCESSING':
      return 'PROCESSING';
    default:
      return 'UNKNOWN';
  }
}
