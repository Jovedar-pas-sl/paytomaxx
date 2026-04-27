import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';

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

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const url = `${this.baseUrl()}/payments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalRef: input.reference,
        amountCents: input.amountCents,
        venueId: input.tenantId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Peanpe authorize failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id?: string };
    return {
      provider: 'PEANPE',
      providerTxId: data.id ?? `PEANPE-${randomUUID()}`,
      status: 'PROCESSING',
    };
  }

  async getStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const res = await fetch(`${this.baseUrl()}/payments/${providerTxId}`);
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { state?: string };
    return mapPeanpeStatus(data.state);
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

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
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
