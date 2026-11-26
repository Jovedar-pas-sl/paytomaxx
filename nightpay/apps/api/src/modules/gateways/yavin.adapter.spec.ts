import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  YAVIN_SECOND_REFUND_TEXT,
  YavinAdapter,
  cartPaidFor,
  newNoticeToken,
  noticeTokenHash,
} from './yavin.adapter';
import { sealYavinKey } from './yavin-credential';
import { isTransientGatewayError } from './gateway-errors';
import { outcomeOfGatewayError } from '../refunds/gateway-refund-outcome';

// Todo inventado: ni la clave ni las URLs son de Yavin de verdad.
const KEK = 'kek-solo-para-pruebas-0123456789abcdefghij';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const FAKE_KEY = 'clave-inventada-de-prueba';
const API = 'http://yavin.simulado';

function makeAdapter(opts: { attemptCents?: number | null; credential?: boolean } = {}) {
  const sealed = sealYavinKey(KEK, TENANT, FAKE_KEY);
  const tx = {
    gatewayCredential: { findFirst: vi.fn(async () => (opts.credential === false ? null : sealed)) },
    payment: { findUnique: vi.fn(async () => ({ tenantId: TENANT })) },
    paymentAttempt: {
      findUnique: vi.fn(async () => (opts.attemptCents === null ? null : { amountCents: opts.attemptCents ?? 2500 })),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const env: Record<string, unknown> = {
    GATEWAY_TIMEOUT_MS: 5000,
    YAVIN_API_URL: API,
    ENCRYPTION_KEK: KEK,
    NEXT_PUBLIC_API_URL: 'https://api.ejemplo.test',
  };
  const config = { get: vi.fn((k: string) => env[k]) };
  const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
  return new YavinAdapter(config as never, metrics as never, prisma as never);
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const authorizeInput = {
  tenantId: TENANT,
  paymentId: PAYMENT,
  attemptId: ATTEMPT,
  amountCents: 2500,
  currency: 'EUR',
  terminalExternalId: '',
  reference: PAYMENT,
};

let fetchSpy: ReturnType<typeof vi.fn>;
let logs: string[];
beforeEach(() => {
  fetchSpy = vi.fn();
  (globalThis as { fetch: unknown }).fetch = fetchSpy;
  logs = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // La clave nunca sale a los logs.
  expect(logs.join('\n')).not.toContain(FAKE_KEY);
});

const bodyOf = (call: unknown[]): Record<string, unknown> => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
const headersOf = (call: unknown[]): Record<string, string> => (call[1] as { headers: Record<string, string> }).headers;

describe('YavinAdapter.authorize: crear el enlace', () => {
  it('POST generate_link con la clave en Yavin-Secret, céntimos, referencia = id del cobro y URL de aviso con token', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { link: 'https://pay.yavin.simulado/c/abc', cart_id: 'cart-1' }));
    const result = await makeAdapter().authorize(authorizeInput);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe(`${API}/api/v5/ecommerce/generate_link/`);
    expect(headersOf(call)['Yavin-Secret']).toBe(FAKE_KEY);
    const body = bodyOf(call);
    expect(body.amount).toBe(2500);
    expect(body.order_id).toBe(ATTEMPT);
    expect(body.return_url_success).toBe('https://api.ejemplo.test/pay/yavin/return?r=ok');
    expect(body.return_url_cancelled).toBe('https://api.ejemplo.test/pay/yavin/return?r=ko');
    const webhook = String(body.webhook_url);
    const token = webhook.split('/').pop()!;
    expect(webhook).toBe(`https://api.ejemplo.test/v1/webhooks/yavin/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(result).toMatchObject({ provider: 'YAVIN', providerTxId: 'cart-1', status: 'PROCESSING', paymentLinkUrl: 'https://pay.yavin.simulado/c/abc' });
    // Solo la huella del token sale del adaptador (para payment_attempts).
    expect(result.noticeTokenHash).toBe(noticeTokenHash(token));
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('cada enlace lleva un token distinto', async () => {
    fetchSpy.mockResolvedValue(reply(200, { link: 'https://pay.yavin.simulado/c/abc', cart_id: 'cart-1' }));
    const a = makeAdapter();
    await a.authorize(authorizeInput);
    await a.authorize(authorizeInput);
    expect(bodyOf(fetchSpy.mock.calls[0]!).webhook_url).not.toBe(bodyOf(fetchSpy.mock.calls[1]!).webhook_url);
  });

  it('menos de 1,00 €: no llama a Yavin y el error es definitivo', async () => {
    const err = await makeAdapter().authorize({ ...authorizeInput, amountCents: 99 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/menos de 1 €/);
    expect(isTransientGatewayError(err)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin credencial del local: definitivo, sin llamar', async () => {
    const err = await makeAdapter({ credential: false }).authorize(authorizeInput).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/credencial/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('error de red: pasajero (se puede reintentar), sin la clave en el mensaje', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    const err = await makeAdapter().authorize(authorizeInput).catch((e: unknown) => e);
    expect(isTransientGatewayError(err)).toBe(true);
    expect(String((err as Error).message)).not.toContain(FAKE_KEY);
  });

  it('5xx: pasajero; 4xx: definitivo; la clave que devuelva Yavin se tapa', async () => {
    fetchSpy.mockResolvedValueOnce(reply(503, { error: 'caído' }));
    expect(isTransientGatewayError(await makeAdapter().authorize(authorizeInput).catch((e: unknown) => e))).toBe(true);
    fetchSpy.mockResolvedValueOnce(reply(400, { error: `clave ${FAKE_KEY} no válida` }));
    const err = await makeAdapter().authorize(authorizeInput).catch((e: unknown) => e);
    expect(isTransientGatewayError(err)).toBe(false);
    expect((err as Error).message).not.toContain(FAKE_KEY);
  });

  it('respuesta sin enlace o sin carrito: definitivo', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { cart_id: 'cart-1' }));
    await expect(makeAdapter().authorize(authorizeInput)).rejects.toThrow(/enlace o carrito/);
  });
});

describe('YavinAdapter: comprobar el pago (get_cart_information)', () => {
  const claim = { paymentId: PAYMENT, providerTxId: 'cart-1', payload: {}, attemptId: ATTEMPT };

  it('pagado → confirmado con el importe que dice Yavin (el procesador lo compara con el del intento)', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2500, currency: 'eur', order_id: PAYMENT }));
    expect(await makeAdapter().proveApproval(claim)).toEqual({ kind: 'confirmed', amountCents: 2500, currency: 'EUR' });
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe(`${API}/api/v5/ecommerce/get_cart_information/`);
    expect(bodyOf(call)).toEqual({ cart_id: 'cart-1' });
    expect(headersOf(call)['Yavin-Secret']).toBe(FAKE_KEY);
  });

  it('no pagado → rechazado', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'pending', amount: 2500, order_id: PAYMENT }));
    expect(await makeAdapter().proveApproval(claim)).toEqual({ kind: 'rejected', reason: 'yavin-no-pagado' });
  });

  it('carrito de otro cobro → rechazado', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2500, order_id: 'otro' }));
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'rejected' });
  });

  it('Yavin no responde → no disponible (se reintenta)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'unavailable' });
    fetchSpy.mockResolvedValueOnce(reply(502, {}));
    expect(await makeAdapter().proveApproval(claim)).toMatchObject({ kind: 'unavailable' });
  });

  it('getStatus: AUTHORIZED solo si pagado e importe igual al céntimo', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2500 }));
    expect(await makeAdapter({ attemptCents: 2500 }).getStatus(TENANT, 'cart-1')).toBe('AUTHORIZED');
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2499 }));
    expect(await makeAdapter({ attemptCents: 2500 }).getStatus(TENANT, 'cart-1')).toBe('UNKNOWN');
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2500 }));
    expect(await makeAdapter({ attemptCents: null }).getStatus(TENANT, 'cart-1')).toBe('UNKNOWN');
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'pending', amount: 2500 }));
    expect(await makeAdapter().getStatus(TENANT, 'cart-1')).toBe('PROCESSING');
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'cancelled', amount: 2500 }));
    expect(await makeAdapter().getStatus(TENANT, 'cart-1')).toBe('FAILED');
    fetchSpy.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await makeAdapter().getStatus(TENANT, 'cart-1')).toBe('UNKNOWN');
  });

  it('cartPaidFor: importe distinto, aunque sea un céntimo, no es pagado', () => {
    expect(cartPaidFor({ status: 'paid', amount: 1000 }, 1000)).toBe(true);
    expect(cartPaidFor({ status: 'paid', amount: 1001 }, 1000)).toBe(false);
    expect(cartPaidFor({ status: 'paid' }, 1000)).toBe(false);
    expect(cartPaidFor({ status: 'pending', amount: 1000 }, 1000)).toBe(false);
  });
});

describe('YavinAdapter.cancelLink: anular', () => {
  it('POST cancel_link con el carrito', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, {}));
    await makeAdapter().cancelLink(TENANT, 'cart-1');
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${API}/api/v5/ecommerce/cancel_link/`);
    expect(bodyOf(fetchSpy.mock.calls[0]!)).toEqual({ cart_id: 'cart-1' });
  });

  it('error de red: lanza (el cobro se cancela igual; lo registra el gancho)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(makeAdapter().cancelLink(TENANT, 'cart-1')).rejects.toThrow(/sin respuesta/);
  });
});

describe('YavinAdapter.refund: una devolución sí, la segunda no', () => {
  const refundInput = { tenantId: TENANT, paymentId: PAYMENT, providerTxId: 'cart-1', amountCents: 1000, reference: 'ref-1' };

  it('la primera: lee la operación del carrito y la devuelve', async () => {
    fetchSpy
      .mockResolvedValueOnce(reply(200, { status: 'paid', amount: 2500, transactions: [{ id: 'tx-9', status: 'paid' }] }))
      .mockResolvedValueOnce(reply(200, { id: 'rf-1' }));
    expect(await makeAdapter().refund(refundInput)).toEqual({ providerRefundId: 'rf-1', status: 'SUCCEEDED' });
    expect(fetchSpy.mock.calls[1]![0]).toBe(`${API}/api/v5/transaction/tx-9/refund/`);
    expect(bodyOf(fetchSpy.mock.calls[1]!)).toEqual({ amount: 1000 });
  });

  it('la segunda (la operación ya está devuelta): no se pide y queda como NO hecha, con mensaje claro', async () => {
    fetchSpy.mockResolvedValueOnce(
      reply(200, { status: 'paid', amount: 2500, transactions: [{ id: 'tx-9', status: 'refunded', refunded_amount: 1000 }] }),
    );
    const err = await makeAdapter().refund(refundInput).catch((e: unknown) => e);
    expect((err as Error).message).toBe(YAVIN_SECOND_REFUND_TEXT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcomeOfGatewayError(err)).toMatchObject({ kind: 'rejected', why: 'declined' });
  });

  it('Yavin la rechaza (4xx): NO hecha; 5xx: no se sabe (queda pendiente)', async () => {
    fetchSpy
      .mockResolvedValueOnce(reply(200, { status: 'paid', transactions: [{ id: 'tx-9' }] }))
      .mockResolvedValueOnce(reply(400, { error: 'ya devuelta' }));
    expect(outcomeOfGatewayError(await makeAdapter().refund(refundInput).catch((e: unknown) => e))).toMatchObject({ kind: 'rejected' });
    fetchSpy
      .mockResolvedValueOnce(reply(200, { status: 'paid', transactions: [{ id: 'tx-9' }] }))
      .mockResolvedValueOnce(reply(500, {}));
    expect(outcomeOfGatewayError(await makeAdapter().refund(refundInput).catch((e: unknown) => e))).toMatchObject({ kind: 'unknown' });
  });

  it('error de red al leer el carrito: no se pidió nada (NO hecha)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await makeAdapter().refund(refundInput).catch((e: unknown) => e);
    expect(outcomeOfGatewayError(err)).toMatchObject({ kind: 'rejected', why: 'not_sent' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('error de red al pedir la devolución: no se sabe (queda pendiente, no se repite)', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { status: 'paid', transactions: [{ id: 'tx-9' }] })).mockRejectedValueOnce(new Error('socket hang up'));
    expect(outcomeOfGatewayError(await makeAdapter().refund(refundInput).catch((e: unknown) => e))).toMatchObject({ kind: 'unknown' });
  });
});

describe('YavinAdapter: el aviso guardado', () => {
  it('mapWebhookToFsmEvent: AUTHORIZED del intento con su carrito (el procesador lo comprueba con Yavin)', () => {
    expect(makeAdapter().mapWebhookToFsmEvent({ attemptId: ATTEMPT, cartId: 'cart-1' })).toEqual({
      paymentId: ATTEMPT,
      event: { type: 'AUTHORIZED', providerTxId: 'cart-1', provider: 'YAVIN' },
    });
    expect(makeAdapter().mapWebhookToFsmEvent({ status: 'paid' })).toBeNull();
  });

  it('verifyWebhook: un id por carrito (el segundo aviso es duplicado)', () => {
    const raw = Buffer.from(JSON.stringify({ attemptId: ATTEMPT, cartId: 'cart-1' }));
    expect(makeAdapter().verifyWebhook({}, raw)).toEqual({ valid: true, externalEventId: 'cart-1_paid', paymentRef: ATTEMPT });
    expect(makeAdapter().verifyWebhook({}, Buffer.from('{}')).valid).toBe(false);
  });

  it('newNoticeToken: 32 bytes al azar y su huella', () => {
    const a = newNoticeToken();
    const b = newNoticeToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(noticeTokenHash(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
