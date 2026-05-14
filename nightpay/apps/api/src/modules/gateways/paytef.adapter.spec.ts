import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaytefAdapter } from './paytef.adapter';

const TOKEN = 'fakePaytefTokenABCDEF123456';
const SECRET = 'paytef-webhook-secret-32-bytes-padding-here';

function makeAdapter() {
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      if (key === 'PAYTEF_API_URL') return 'http://mock-paytef';
      if (key === 'PAYTEF_API_TOKEN') return TOKEN;
      if (key === 'PAYTEF_WEBHOOK_SECRET') return SECRET;
      if (key === 'PAYTEF_WEBHOOK_URL') return 'http://localhost:4100/v1/webhooks/paytef';
      if (key === 'PAYTEF_COMPANY_ID') return 76861;
      if (key === 'PAYTEF_BRANCH_ID') return 1;
      return undefined;
    }),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      throw new Error(`unknown config key: ${key}`);
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PaytefAdapter(config as any, metrics as any);
}

describe('PaytefAdapter.authorize', () => {
  let adapter: PaytefAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = makeAdapter();
    fetchSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
  });

  it('llama POST /payment-link/save + /publish y devuelve providerTxId', async () => {
    // 1ª llamada: save → success + paymentID
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        paymentID: 'pl-abc-123',
        paymentURL: 'https://link.paytef.es/link/pl-abc-123',
      }),
      text: async () => '',
    });
    // 2ª llamada: publish → 200 OK
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { success: true } }),
      text: async () => '',
    });

    const result = await adapter.authorize({
      tenantId: 'venue-1',
      paymentId: 'payment-uuid-1',
      amountCents: 5000,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'payment-uuid-1',
    });

    expect(result.provider).toBe('PAYTEF');
    expect(result.providerTxId).toBe('pl-abc-123');
    expect(result.status).toBe('PROCESSING');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [saveCall, publishCall] = fetchSpy.mock.calls;
    expect(saveCall![0]).toContain('/payment-link/save');
    expect(publishCall![0]).toContain('/payment-link/publish');
  });

  it('lanza si save falla con !ok', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid auth',
    });
    await expect(
      adapter.authorize({
        tenantId: 'v1',
        paymentId: 'p1',
        amountCents: 100,
        currency: 'EUR',
        terminalExternalId: '',
        reference: 'p1',
      }),
    ).rejects.toThrow(/Paytef \/save failed/);
  });

  it('lanza si save responde sin paymentID', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      text: async () => '',
    });
    await expect(
      adapter.authorize({
        tenantId: 'v1',
        paymentId: 'p1',
        amountCents: 100,
        currency: 'EUR',
        terminalExternalId: '',
        reference: 'p1',
      }),
    ).rejects.toThrow(/no paymentID/);
  });

  it('header Authorization usa formato PAYTEF-TOKEN', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        paymentID: 'pl-1',
        paymentURL: 'https://link.paytef.es/link/pl-1',
      }),
      text: async () => '',
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { success: true } }),
      text: async () => '',
    });

    await adapter.authorize({
      tenantId: 'v1',
      paymentId: 'p1',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'p1',
    });

    const saveCall = fetchSpy.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = saveCall![1] as any;
    expect(opts.headers.Authorization).toBe(`PAYTEF-TOKEN ${TOKEN}`);
  });
});

describe('PaytefAdapter.getStatus', () => {
  let adapter: PaytefAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = makeAdapter();
    fetchSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
  });

  it('AUTHORIZED cuando lastResult.isApproved=true', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 'pl-1', lastResult: { isApproved: true, txnKey: 't-1' } },
      }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('AUTHORIZED');
  });

  it('FAILED cuando isCanceled', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: 'pl-1', isCanceled: true } }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('FAILED');
  });

  it('FAILED cuando isExpired', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: 'pl-1', isExpired: true } }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('FAILED');
  });

  it('FAILED cuando lastResult.isApproved=false', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 'pl-1', lastResult: { isApproved: false, resultReason: 'declined' } },
      }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('FAILED');
  });

  it('PROCESSING por defecto (esperando pago)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: 'pl-1' } }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('PROCESSING');
  });

  it('UNKNOWN si fetch falla', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('UNKNOWN');
  });
});

describe('PaytefAdapter.refund', () => {
  it('lanza error con mensaje claro (Paytef NO soporta refund API)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.refund({
        tenantId: 'v1',
        paymentId: 'p1',
        providerTxId: 'pl-1',
        amountCents: 1000,
        reference: 'r1',
      }),
    ).rejects.toThrow(/paytef-refund-manual-required/);
  });
});

describe('PaytefAdapter.verifyWebhook (URL secreta + payload)', () => {
  let adapter: PaytefAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('valida payload con paymentID + clientID', () => {
    const body = JSON.stringify({
      paymentID: 'pl-1',
      data: {
        id: 'pl-1',
        clientID: 'nightpay-payment-uuid',
        lastResult: { txnKey: 't-1', isApproved: true },
      },
    });
    const res = adapter.verifyWebhook({}, Buffer.from(body, 'utf8'));
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.externalEventId).toBe('pl-1_t-1');
      expect(res.paymentRef).toBe('nightpay-payment-uuid');
    }
  });

  it('rechaza JSON inválido', () => {
    const res = adapter.verifyWebhook({}, Buffer.from('not json', 'utf8'));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('invalid-json');
  });

  it('rechaza payload sin clientID', () => {
    const body = JSON.stringify({ paymentID: 'pl-1', data: { id: 'pl-1' } });
    const res = adapter.verifyWebhook({}, Buffer.from(body, 'utf8'));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('missing-paymentID-or-clientID');
  });
});

describe('PaytefAdapter.mapWebhookToFsmEvent', () => {
  const adapter = makeAdapter();

  it('AUTHORIZED cuando lastResult.isApproved=true', () => {
    const event = adapter.mapWebhookToFsmEvent({
      paymentID: 'pl-1',
      data: {
        id: 'pl-1',
        clientID: 'pay-uuid',
        lastResult: { isApproved: true, txnKey: 't-1' },
      },
    });
    expect(event).not.toBeNull();
    expect(event!.paymentId).toBe('pay-uuid');
    expect(event!.event.type).toBe('AUTHORIZED');
    if (event!.event.type === 'AUTHORIZED') {
      expect(event!.event.provider).toBe('PAYTEF');
    }
  });

  it('FAILED cuando isCanceled', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: { id: 'pl-1', clientID: 'pay-uuid', isCanceled: true },
    });
    expect(event!.event.type).toBe('FAILED');
  });

  it('FAILED cuando lastResult.isApproved=false con reason', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: {
        id: 'pl-1',
        clientID: 'pay-uuid',
        lastResult: { isApproved: false, resultReason: 'card_declined' },
      },
    });
    expect(event!.event.type).toBe('FAILED');
    if (event!.event.type === 'FAILED') {
      expect(event!.event.reason).toBe('card_declined');
    }
  });

  it('null cuando lifecycle interno sin estado terminal', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: { id: 'pl-1', clientID: 'pay-uuid' },
    });
    expect(event).toBeNull();
  });
});
