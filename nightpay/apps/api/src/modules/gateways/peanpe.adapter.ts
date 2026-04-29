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

const PROVIDER_LABEL = 'PEANPE' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

interface PeanpeWebhook {
  id?: string;
  type?: string;
  providerTxId?: string;
  externalRef?: string;
  amountCents?: number;
  ts?: string;
}

@Injectable()
export class PeanpeAdapter implements GatewayAdapter {
  readonly provider = 'PEANPE' as const;

  private readonly logger = new Logger(PeanpeAdapter.name);
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
      name: 'peanpe.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'peanpe.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'peanpe.refund',
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
    const url = `${this.baseUrl()}/payments`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalRef: input.reference,
          amountCents: input.amountCents,
          venueId: input.tenantId,
        }),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Peanpe authorize failed: ${res.status}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('Peanpe authorize: missing id');
    return {
      provider: 'PEANPE',
      providerTxId: data.id,
      status: 'PROCESSING',
    };
  }

  private async doGetStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}/payments/${providerTxId}`,
      {},
      this.timeoutMs,
    );
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { state?: string };
    return mapPeanpeStatus(data.state);
  }

  private async doRefund(input: RefundInput): Promise<RefundResult> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}/payments/${input.providerTxId}/refund`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.reference,
        },
        body: JSON.stringify({
          amountCents: input.amountCents,
          reason: input.reason ?? '',
        }),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Peanpe refund failed: ${res.status}`);
    }
    const data = (await res.json()) as { id?: string; state?: string };
    if (!data.id) throw new Error('Peanpe refund: missing id');
    return {
      providerRefundId: data.id,
      status: data.state?.toLowerCase() === 'failed' ? 'FAILED' : 'SUCCEEDED',
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

    const secret = this.config.getOrThrow<string>('PEANPE_WEBHOOK_SECRET');
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

    let parsed: PeanpeWebhook;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as PeanpeWebhook;
    } catch {
      return { valid: false, reason: 'invalid-json' };
    }
    if (!parsed.id || !parsed.externalRef) {
      return { valid: false, reason: 'missing-id-or-ref' };
    }
    return { valid: true, externalEventId: parsed.id, paymentRef: parsed.externalRef };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const p = parsedPayload as PeanpeWebhook;
    if (!p.externalRef || !p.providerTxId) return null;

    if (p.type === 'payment.authorized') {
      return {
        paymentId: p.externalRef,
        event: { type: 'AUTHORIZED', providerTxId: p.providerTxId, provider: 'PEANPE' },
      };
    }
    if (p.type === 'payment.failed' || p.type === 'payment.voided') {
      return {
        paymentId: p.externalRef,
        event: { type: 'FAILED', reason: p.type },
      };
    }
    return null;
  }

  private baseUrl(): string {
    return this.config.getOrThrow<string>('PEANPE_API_URL');
  }
}

function mapPeanpeStatus(s: string | undefined): GatewayStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'authorized':
      return 'AUTHORIZED';
    case 'failed':
    case 'voided':
      return 'FAILED';
    case 'processing':
      return 'PROCESSING';
    default:
      return 'UNKNOWN';
  }
}
