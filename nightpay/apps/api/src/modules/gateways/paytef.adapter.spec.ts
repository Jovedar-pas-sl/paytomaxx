import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaytefAdapter, paytefTestMode } from './paytef.adapter';

const TOKEN = 'fakePaytefTokenABCDEF123456';
const SECRET = 'paytef-webhook-secret-32-bytes-padding-here';

function makeAdapter(env: Record<string, string | undefined> = {}) {
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key in env) return env[key];
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
  return new PaytefAdapter(config as any, metrics as any);
}

describe('PaytefAdapter.authorize', () => {
  let adapter: PaytefAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = makeAdapter();
    fetchSpy = vi.fn();
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
    const opts = saveCall![1] as any;
    expect(opts.headers.Authorization).toBe(`PAYTEF-TOKEN ${TOKEN}`);
  });
});

describe('Paytef modo test (#2)', () => {
  it('paytefTestMode: la variable manda; sin ella, producción = real (y avisa), desarrollo = test', () => {
    expect(paytefTestMode('true', 'production')).toEqual({ isTest: true, warn: false });
    expect(paytefTestMode('false', 'development')).toEqual({ isTest: false, warn: false });
    expect(paytefTestMode(undefined, 'production')).toEqual({ isTest: false, warn: true });
    expect(paytefTestMode(undefined, 'development')).toEqual({ isTest: true, warn: false });
    expect(paytefTestMode(undefined, undefined)).toEqual({ isTest: true, warn: false });
  });

  async function sentIsTest(env: Record<string, string | undefined>): Promise<unknown> {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, paymentID: 'pl-1', paymentURL: 'https://link.paytef.es/link/pl-1' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}), text: async () => '' });
    (globalThis as any).fetch = fetchSpy;
    await makeAdapter(env).authorize({
      tenantId: 'v1',
      paymentId: 'p1',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'p1',
    });
    return JSON.parse(String((fetchSpy.mock.calls[0]![1] as { body: string }).body)).data.isTest;
  }

  it('en producción sin PAYTEF_FORCE_TEST el link se crea en modo real', async () => {
    expect(await sentIsTest({ NODE_ENV: 'production' })).toBe(false);
    expect(await sentIsTest({ NODE_ENV: 'production', PAYTEF_FORCE_TEST: 'true' })).toBe(true);
    expect(await sentIsTest({ NODE_ENV: 'development' })).toBe(true);
  });
});

describe('PaytefAdapter.getStatus', () => {
  let adapter: PaytefAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = makeAdapter();
    fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
  });

  it('AUTHORIZED aunque el link haya caducado después de pagarse', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 'pl-1', isExpired: true, lastResult: { isApproved: true, txnKey: 't-1' } },
      }),
    });
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('AUTHORIZED');
  });

  it('UNKNOWN si Paytef no responde (red caída) en vez de lanzar', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await adapter.getStatus('v1', 'pl-1')).toBe('UNKNOWN');
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

  it('rechaza id del link vacío o dos ids distintos (#51)', () => {
    const empty = JSON.stringify({ paymentID: '', data: { id: '  ', clientID: 'pay-uuid' } });
    expect(adapter.verifyWebhook({}, Buffer.from(empty, 'utf8')).valid).toBe(false);
    const twoIds = JSON.stringify({ paymentID: 'pl-1', data: { id: 'pl-2', clientID: 'pay-uuid' } });
    expect(adapter.verifyWebhook({}, Buffer.from(twoIds, 'utf8')).valid).toBe(false);
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

  it('denegación → null: el cliente puede reintentar en el mismo link (#5)', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: {
        id: 'pl-1',
        clientID: 'pay-uuid',
        lastResult: { isApproved: false, resultReason: 'card_declined' },
      },
    });
    expect(event).toBeNull();
  });

  it('aprobado aunque el aviso diga caducado → AUTHORIZED con el id del link', () => {
    const event = adapter.mapWebhookToFsmEvent({
      paymentID: 'pl-1',
      data: { clientID: 'pay-uuid', isExpired: true, lastResult: { isApproved: true } },
    });
    expect(event?.event).toEqual({ type: 'AUTHORIZED', providerTxId: 'pl-1', provider: 'PAYTEF' });
  });

  it('aprobado sin id del link → null (nunca providerTxId vacío)', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: { clientID: 'pay-uuid', lastResult: { isApproved: true } },
    });
    expect(event).toBeNull();
  });

  it('null cuando lifecycle interno sin estado terminal', () => {
    const event = adapter.mapWebhookToFsmEvent({
      data: { id: 'pl-1', clientID: 'pay-uuid' },
    });
    expect(event).toBeNull();
  });
});

describe('PaytefAdapter.proveApproval — se pregunta a Paytef, no al aviso (#2)', () => {
  const claim = { paymentId: 'pay-uuid', providerTxId: 'pl-1', payload: {} };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
  });
  const linkResponse = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ data }) });

  it('aprobado, de este cobro y con importe → confirmed con el importe de Paytef', async () => {
    fetchSpy.mockResolvedValueOnce(
      linkResponse({ id: 'pl-1', clientID: 'pay-uuid', amountCents: 5000, currency: 'EUR', lastResult: { isApproved: true } }),
    );
    expect(await makeAdapter().proveApproval(claim)).toEqual({ kind: 'confirmed', amountCents: 5000, currency: 'EUR' });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://mock-paytef/payment-link/get/pl-1');
  });

  it('Paytef dice que no está aprobado (aviso falso con la URL secreta) → rejected', async () => {
    fetchSpy.mockResolvedValueOnce(linkResponse({ id: 'pl-1', clientID: 'pay-uuid', amountCents: 5000 }));
    expect(await makeAdapter().proveApproval(claim)).toEqual({ kind: 'rejected', reason: 'paytef-no-aprobado' });
  });

  it('el link es de otro cobro → rejected', async () => {
    fetchSpy.mockResolvedValueOnce(
      linkResponse({ id: 'pl-1', clientID: 'otro-cobro', amountCents: 5000, lastResult: { isApproved: true } }),
    );
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'rejected', reason: 'paytef-link-de-otro-cobro' });
  });

  it('sin importe en Paytef → rejected (no se puede comprobar)', async () => {
    fetchSpy.mockResolvedValueOnce(linkResponse({ id: 'pl-1', clientID: 'pay-uuid', lastResult: { isApproved: true } }));
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'rejected', reason: 'paytef-sin-importe' });
  });

  it('Paytef caído o con error → unavailable (se reintenta)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'unavailable', reason: 'paytef-http-503' });
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'unavailable' });
  });
});
