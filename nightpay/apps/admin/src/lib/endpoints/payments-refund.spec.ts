import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(), totpAwareError: vi.fn() }));
import { authedFetch, totpAwareError } from '../http';
import { ApiError } from '../api-errors';
import { refundPayment } from './payments';

describe('refund browser intention', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('recupera la clave guardada por una pestaña antes de una recarga del navegador', async () => {
    const saved = '00000000-0000-4000-8000-000000000001';
    const storage = new Map([['nightpay:refund:restored', JSON.stringify({ fingerprint: JSON.stringify([1000, 'Cliente']), key: saved })]]);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.mocked(authedFetch).mockImplementation(async () => new Response('{}', { status: 201 }));
    await refundPayment('restored', 1000, 'Cliente');
    expect(JSON.parse(String(vi.mocked(authedFetch).mock.calls[0]![1]?.body))).toMatchObject({ idempotencyKey: saved });
    expect(storage.has('nightpay:refund:restored')).toBe(false);
  });

  it.each(['REFUND_REJECTED', 'REFUND_OUTCOME_UNKNOWN'])('solo libera la intención tras resultado definitivo (%s)', async (code) => {
    const fetch = vi.mocked(authedFetch);
    fetch.mockResolvedValueOnce(new Response('', { status: code === 'REFUND_REJECTED' ? 409 : 502 }));
    fetch.mockImplementation(async () => new Response('{}', { status: 201 }));
    vi.mocked(totpAwareError).mockResolvedValueOnce(new ApiError('resultado', 409, code));
    const paymentId = `error-${code}`;
    await expect(refundPayment(paymentId, 1000)).rejects.toThrow('resultado');
    await refundPayment(paymentId, 1000);
    const keys = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
    expect(keys[0] === keys[1]).toBe(code === 'REFUND_OUTCOME_UNKNOWN');
  });
  it('conserva clave tras respuesta perdida y crea otra para una devolución deliberada tras éxito', async () => {
    const fetch = vi.mocked(authedFetch);
    fetch.mockRejectedValueOnce(new Error('response lost'));
    fetch.mockImplementation(async () => new Response(JSON.stringify({ id: 'r1', status: 'SUCCEEDED' }), { status: 201 }));
    await expect(refundPayment('payment-idempotent', 1000, 'Cliente')).rejects.toThrow('response lost');
    await refundPayment('payment-idempotent', 1000, 'Cliente', '123456');
    await refundPayment('payment-idempotent', 1000, 'Cliente');
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect(bodies[2].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
  });
});
