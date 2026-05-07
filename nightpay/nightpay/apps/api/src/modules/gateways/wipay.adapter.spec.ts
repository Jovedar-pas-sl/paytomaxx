import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WipayAdapter } from './wipay.adapter';

const SECRET = 'test-wipay-secret-32-bytes-or-more-padding';
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function makeAdapter() {
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      return undefined;
    }),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      if (key === 'WIPAY_WEBHOOK_SECRET') return SECRET;
      if (key === 'WIPAY_API_URL') return 'http://mock-wipay';
      throw new Error(`unknown config key: ${key}`);
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new WipayAdapter(config as any, metrics as any);
}

function sign(ts: number, body: string): string {
  return createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
}

function buildPayload(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    event_id: 'evt-1',
    event_type: 'payment.authorized',
    transaction_id: 'wp-tx-1',
    reference: 'pay-uuid-1',
    amount: 5000,
    currency: 'EUR',
    timestamp: Date.now(),
    ...overrides,
  });
}

describe('WipayAdapter.verifyWebhook — HMAC validation', () => {
  let adapter: WipayAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('accepts a correctly-signed payload within the replay window', () => {
    const body = buildPayload();
    const ts = Date.now();
    const headers = { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) };
    const result = adapter.verifyWebhook(headers, Buffer.from(body));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.externalEventId).toBe('evt-1');
      expect(result.paymentRef).toBe('pay-uuid-1');
    }
  });

  it('rejects when signature is missing', () => {
    const body = buildPayload();
    const result = adapter.verifyWebhook({ 'x-timestamp': String(Date.now()) }, Buffer.from(body));
    expect(result).toEqual({ valid: false, reason: 'missing-signature-or-timestamp' });
  });

  it('rejects when timestamp is missing', () => {
    const body = buildPayload();
    const result = adapter.verifyWebhook({ 'x-signature': 'aabbcc' }, Buffer.from(body));
    expect(result).toEqual({ valid: false, reason: 'missing-signature-or-timestamp' });
  });

  it('rejects when timestamp is outside the replay window (old)', () => {
    const body = buildPayload();
    const ts = Date.now() - REPLAY_WINDOW_MS - 1000; // 5min1s old
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'timestamp-out-of-window' });
  });

  it('rejects when timestamp is outside the replay window (future)', () => {
    const body = buildPayload();
    const ts = Date.now() + REPLAY_WINDOW_MS + 1000; // 5min1s in future
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'timestamp-out-of-window' });
  });

  it('rejects non-numeric timestamp', () => {
    const body = buildPayload();
    const result = adapter.verifyWebhook(
      { 'x-signature': 'aabbcc', 'x-timestamp': 'not-a-number' },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'timestamp-out-of-window' });
  });

  it('rejects when signature does not match (tampered body)', () => {
    const body = buildPayload();
    const ts = Date.now();
    const validSig = sign(ts, body);
    // Body tampered AFTER signing
    const tamperedBody = body.replace('5000', '500000');
    const result = adapter.verifyWebhook(
      { 'x-signature': validSig, 'x-timestamp': String(ts) },
      Buffer.from(tamperedBody),
    );
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  it('rejects when secret used for signing is wrong', () => {
    const body = buildPayload();
    const ts = Date.now();
    const wrongSig = createHmac('sha256', 'attacker-guess').update(`${ts}.${body}`).digest('hex');
    const result = adapter.verifyWebhook(
      { 'x-signature': wrongSig, 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  it('rejects malformed hex signature gracefully', () => {
    const body = buildPayload();
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': 'not-hex-zzzz', 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    // Either invalid-signature-encoding or signature-mismatch — both safe
    expect(result.valid).toBe(false);
  });

  it('rejects when body is not valid JSON', () => {
    const body = 'this is not json';
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'invalid-json' });
  });

  it('rejects when JSON is missing event_id', () => {
    const body = JSON.stringify({ reference: 'pay-1', transaction_id: 'tx' });
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'missing-event-id-or-reference' });
  });

  it('rejects when JSON is missing reference', () => {
    const body = JSON.stringify({ event_id: 'evt-1', transaction_id: 'tx' });
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': sign(ts, body), 'x-timestamp': String(ts) },
      Buffer.from(body),
    );
    expect(result).toEqual({ valid: false, reason: 'missing-event-id-or-reference' });
  });

  it('reads signature from array-form header (proxy-mangled)', () => {
    const body = buildPayload();
    const ts = Date.now();
    const result = adapter.verifyWebhook(
      { 'x-signature': [sign(ts, body)], 'x-timestamp': [String(ts)] },
      Buffer.from(body),
    );
    expect(result.valid).toBe(true);
  });
});

describe('WipayAdapter.mapWebhookToFsmEvent', () => {
  let adapter: WipayAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('maps payment.authorized → AUTHORIZED FSM event', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.authorized',
      reference: 'pay-1',
      transaction_id: 'tx-1',
    });
    expect(evt).toEqual({
      paymentId: 'pay-1',
      event: { type: 'AUTHORIZED', providerTxId: 'tx-1', provider: 'WIPAY' },
    });
  });

  it('maps payment.failed → FAILED FSM event', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.failed',
      reference: 'pay-1',
      transaction_id: 'tx-1',
    });
    expect(evt?.event.type).toBe('FAILED');
  });

  it('maps payment.voided → FAILED FSM event', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.voided',
      reference: 'pay-1',
      transaction_id: 'tx-1',
    });
    expect(evt?.event.type).toBe('FAILED');
  });

  it('returns null for unknown event types', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.something_unexpected',
      reference: 'pay-1',
      transaction_id: 'tx-1',
    });
    expect(evt).toBeNull();
  });

  it('returns null when reference is missing', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.authorized',
      transaction_id: 'tx-1',
    });
    expect(evt).toBeNull();
  });

  it('returns null when transaction_id is missing', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      event_type: 'payment.authorized',
      reference: 'pay-1',
    });
    expect(evt).toBeNull();
  });
});
