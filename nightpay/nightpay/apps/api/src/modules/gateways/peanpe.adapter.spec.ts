import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PeanpeAdapter } from './peanpe.adapter';

const SECRET = 'test-peanpe-secret-32-bytes-or-more-padding';
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function makeAdapter() {
  const config = {
    get: vi.fn().mockImplementation((key: string) => (key === 'GATEWAY_TIMEOUT_MS' ? 5000 : undefined)),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      if (key === 'PEANPE_WEBHOOK_SECRET') return SECRET;
      if (key === 'PEANPE_API_URL') return 'http://mock-peanpe';
      throw new Error(`unknown config key: ${key}`);
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PeanpeAdapter(config as any, metrics as any);
}

function sign(ts: number, body: string): string {
  return createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
}

function buildPayload(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: 'evt-1',
    type: 'payment.authorized',
    providerTxId: 'pp-tx-1',
    externalRef: 'pay-uuid-1',
    amountCents: 5000,
    ts: new Date().toISOString(),
    ...overrides,
  });
}

describe('PeanpeAdapter.verifyWebhook — HMAC validation', () => {
  let adapter: PeanpeAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('accepts a correctly-signed payload', () => {
    const body = buildPayload();
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.externalEventId).toBe('evt-1');
      expect(result.paymentRef).toBe('pay-uuid-1');
    }
  });

  it('rejects expired timestamp', () => {
    const body = buildPayload();
    const ts = Date.now() - REPLAY_WINDOW_MS - 1000;
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects tampered body', () => {
    const body = buildPayload();
    const ts = Date.now();
    const sig = sign(ts, body);
    const tampered = body.replace('5000', '50000');
    const result = adapter.verifyWebhook(
      { 'x-signature': sig, 'x-timestamp': String(ts) },
      Buffer.from(tampered),
    );
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  it('rejects when JSON missing externalRef', () => {
    const body = JSON.stringify({ id: 'evt-1', providerTxId: 'tx' });
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'missing-id-or-ref' });
  });

  it('rejects when JSON missing id', () => {
    const body = JSON.stringify({ externalRef: 'pay-1', providerTxId: 'tx' });
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'missing-id-or-ref' });
  });
});

describe('PeanpeAdapter.mapWebhookToFsmEvent', () => {
  let adapter: PeanpeAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('maps payment.authorized → AUTHORIZED', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      type: 'payment.authorized',
      externalRef: 'pay-1',
      providerTxId: 'tx-1',
    });
    expect(evt).toEqual({
      paymentId: 'pay-1',
      event: { type: 'AUTHORIZED', providerTxId: 'tx-1', provider: 'PEANPE' },
    });
  });

  it('maps payment.failed → FAILED', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      type: 'payment.failed',
      externalRef: 'pay-1',
      providerTxId: 'tx-1',
    });
    expect(evt?.event.type).toBe('FAILED');
  });

  it('maps payment.voided → FAILED', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      type: 'payment.voided',
      externalRef: 'pay-1',
      providerTxId: 'tx-1',
    });
    expect(evt?.event.type).toBe('FAILED');
  });

  it('returns null for unknown type', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      type: 'payment.weirdo',
      externalRef: 'pay-1',
      providerTxId: 'tx-1',
    });
    expect(evt).toBeNull();
  });
});
