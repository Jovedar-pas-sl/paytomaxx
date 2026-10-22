import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(), totpAwareError: vi.fn() }));

import { authedFetch, totpAwareError } from '../http';
import { ApiError } from '../api-errors';
import { REFUND_INTENT_TTL_MS } from '../refund-intent';
import { refundPayment } from './payments';

/** La clave que llevó cada petición al API. */
const sentKeys = () => vi.mocked(authedFetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey as string);
const ok = (body: unknown = { id: 'r-1', status: 'SUCCEEDED', providerRefundId: null }, status = 201) =>
  new Response(JSON.stringify(body), { status });
let payment = 0;
const nextPayment = () => `payment-${(payment += 1)}`;

function fakeSessionStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  fakeSessionStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('devolución desde el panel: una clave por intención', () => {
  it('la respuesta se pierde: el reintento lleva la misma clave aunque cambie el importe o el código 2FA', async () => {
    const id = nextPayment();
    vi.mocked(authedFetch).mockRejectedValueOnce(new Error('Failed to fetch')).mockImplementation(async () => ok());
    await expect(refundPayment(id, 1000, 'Cliente')).rejects.toThrow('Failed to fetch');
    await refundPayment(id, 1200, 'Cliente', '123456');
    const [first, retry] = sentKeys();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry).toBe(first);
  });

  it('dos devoluciones parciales a propósito: tras la respuesta de la primera, la segunda lleva otra clave', async () => {
    const id = nextPayment();
    vi.mocked(authedFetch).mockImplementation(async () => ok());
    await refundPayment(id, 500);
    await refundPayment(id, 500);
    const [a, b] = sentKeys();
    expect(a).not.toBe(b);
  });

  it('pedida al dueño (202): también es respuesta, la siguiente es otra', async () => {
    const id = nextPayment();
    vi.mocked(authedFetch).mockImplementation(async () =>
      ok({ approvalRequestId: 'a-1', status: 'PENDING', kind: 'REFUND', amountCents: 15000, message: 'x' }, 202),
    );
    await refundPayment(id, 15000);
    await refundPayment(id, 15000);
    const [a, b] = sentKeys();
    expect(a).not.toBe(b);
  });

  it.each([
    ['REFUND_REJECTED', 409, true],
    ['REFUND_FAILED', 409, true],
    ['REFUND_KEY_REUSED', 409, true],
    ['REFUND_APPROVAL_CLOSED', 409, true],
    ['REFUND_OUTCOME_UNKNOWN', 502, false],
    ['REFUND_IN_PROGRESS', 409, false],
    ['REFUND_SETTLE_REJECTED', 409, false],
    ['TOTP_REQUIRED', 403, false],
  ] as const)('%s: ¿la siguiente es otra devolución? %s', async (code, status, fresh) => {
    const id = nextPayment();
    vi.mocked(authedFetch).mockResolvedValueOnce(new Response('', { status })).mockImplementation(async () => ok());
    vi.mocked(totpAwareError).mockResolvedValueOnce(new ApiError('respuesta', status, code));
    await expect(refundPayment(id, 1000)).rejects.toThrow('respuesta');
    await refundPayment(id, 1000);
    const [a, b] = sentKeys();
    expect(a !== b).toBe(fresh);
  });

  it('cerrar la pestaña del modal o recargar: la clave sin respuesta sigue en la sesión de la pestaña', async () => {
    const id = nextPayment();
    const saved = { key: '00000000-0000-4000-8000-000000000001', createdAt: Date.now() };
    sessionStorage.setItem(`nightpay:refund-intent:${id}`, JSON.stringify(saved));
    vi.mocked(authedFetch).mockImplementation(async () => ok());
    await refundPayment(id, 1000);
    expect(sentKeys()).toEqual([saved.key]);
    expect(sessionStorage.getItem(`nightpay:refund-intent:${id}`)).toBeNull();
  });

  it('pasado el rato sin respuesta, la siguiente es otra (y una guardada rota no se usa)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = nextPayment();
    vi.mocked(authedFetch).mockRejectedValueOnce(new Error('Failed to fetch')).mockImplementation(async () => ok());
    await expect(refundPayment(id, 1000)).rejects.toThrow();
    vi.setSystemTime(Date.now() + REFUND_INTENT_TTL_MS + 1);
    await refundPayment(id, 1000);
    const broken = nextPayment();
    sessionStorage.setItem(`nightpay:refund-intent:${broken}`, '{"key": 7}');
    await refundPayment(broken, 1000);
    const [a, b, c] = sentKeys();
    expect(b).not.toBe(a);
    expect(c).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sin almacenamiento (navegación privada): la de memoria sigue valiendo para el reintento', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    const id = nextPayment();
    vi.mocked(authedFetch).mockRejectedValueOnce(new Error('Failed to fetch')).mockImplementation(async () => ok());
    await expect(refundPayment(id, 1000)).rejects.toThrow();
    await refundPayment(id, 1000);
    const [a, b] = sentKeys();
    expect(b).toBe(a);
  });
});
