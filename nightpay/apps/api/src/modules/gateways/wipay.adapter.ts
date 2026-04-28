import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';

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

/**
 * Adapter Wipay (mock en dev — apunta a localhost:4901).
 */
@Injectable()
export class WipayAdapter implements GatewayAdapter {
  readonly provider = 'WIPAY' as const;

  private readonly logger = new Logger(WipayAdapter.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const url = `${this.baseUrl()}/v1/authorize`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amountCents,
        currency: input.currency,
        terminal: input.terminalExternalId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Wipay authorize failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { transaction_id?: string };
    return {
      provider: 'WIPAY',
      providerTxId: data.transaction_id ?? `WPY-${randomUUID()}`,
      status: 'PROCESSING',
    };
  }

  async getStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const res = await fetch(`${this.baseUrl()}/v1/transactions/${providerTxId}`);
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { status?: string };
    return mapWipayStatus(data.status);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const res = await fetch(`${this.baseUrl()}/v1/transactions/${input.providerTxId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.reference,
      },
      body: JSON.stringify({
        amount: input.amountCents,
        reason: input.reason ?? '',
      }),
    });
    if (!res.ok) {
      throw new Error(`Wipay refund failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { refund_id?: string; status?: string };
    return {
      providerRefundId: data.refund_id ?? `WPY-RF-${randomUUID()}`,
      status: (data.status?.toUpperCase() === 'FAILED' ? 'FAILED' : 'SUCCEEDED') as
        | 'SUCCEEDED'
        | 'FAILED',
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
    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody.toString('utf8')}`).digest('hex');

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

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
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
