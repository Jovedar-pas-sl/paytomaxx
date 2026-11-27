import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedis, type FakeRedis } from '../../auth/testing/fake-redis';
import { PartnerHttpException } from '../http/partner-problem';
import { PartnerWalletLimits } from './partner-wallet-limits';

const CONN = 'c0000000-0000-4000-8000-000000000001';
const W1 = 'w1111111-1111-4111-8111-111111111111';
const W2 = 'w2222222-2222-4222-8222-222222222222';
const auth = {
  connection: { id: CONN, tenantId: 'venue-a', partner: { name: 'Cajeros Demo' } },
  keyHint: 'oxp_test_…a1b2',
} as never;

let redis: FakeRedis;
let audit: { log: ReturnType<typeof vi.fn> };
let limits: PartnerWalletLimits;

const at = (iso: string) => vi.setSystemTime(new Date(iso));
async function refusal(p: Promise<unknown>): Promise<PartnerHttpException> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PartnerHttpException);
  return err as PartnerHttpException;
}
const actions = () => audit.log.mock.calls.map(([input]) => (input as { action: string; payload: { limit?: string } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-12-05T22:41:05Z');
  redis = createFakeRedis();
  audit = { log: vi.fn(async () => undefined) };
  limits = new PartnerWalletLimits(redis as never, audit as never);
});
afterEach(() => vi.useRealTimers());

describe('lecturas por saldo: 12 por minuto', () => {
  it('la 13.ª del minuto, 429 hasta el minuto siguiente; otro saldo sigue', async () => {
    for (let i = 0; i < 12; i += 1) await limits.balance(auth, W1, 'ficha');
    const err = await refusal(limits.balance(auth, W1, 'ficha'));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(55);
    await expect(limits.balance(auth, W2, 'ficha')).resolves.toBeUndefined();
  });

  it('el 429 del minuto no toca la noche', async () => {
    for (let i = 0; i < 14; i += 1) await limits.balance(auth, W1, 'ficha').catch(() => undefined);
    expect(await redis.get(`np:prl:balnight:ficha:${CONN}:${W1}:2026-12-05`)).toBe('12');
  });
});

describe('lecturas por saldo y noche: 20 con ficha y 120 con código, aparte', () => {
  async function readsOver(minutes: number, perMinute: number, kind: 'ficha' | 'ficha_nfc' | 'live_code', from = 0) {
    let ok = 0;
    for (let m = 0; m < minutes; m += 1) {
      at(new Date(Date.UTC(2026, 11, 5, 22, from + m, 5)).toISOString());
      for (let i = 0; i < perMinute; i += 1) {
        if (await limits.balance(auth, W1, kind).then(() => true, () => false)) ok += 1;
      }
    }
    return ok;
  }

  it('con ficha (con o sin UID), 20; con código, 120 además', async () => {
    expect(await readsOver(2, 10, 'ficha')).toBe(20);
    expect(await limits.balance(auth, W1, 'ficha_nfc').then(() => 'ok', (e: PartnerHttpException) => e.code)).toBe('rate_limited');
    expect(await readsOver(12, 11, 'live_code', 5)).toBe(120);
    expect(await readsOver(1, 1, 'live_code', 30)).toBe(0);
  });

  it('Retry-After hasta las 08:00 de Madrid (un 5-dic a las 23:41) y la noche dura 48 h en Redis', async () => {
    at('2026-12-05T22:41:00Z');
    const key = `np:prl:balnight:ficha:${CONN}:${W1}:2026-12-05`;
    await redis.set(key, '20');
    const err = await refusal(limits.balance(auth, W1, 'ficha'));
    expect(err.retryAfter).toBe(8 * 3600 + 19 * 60);
    await redis.del(key);
    await limits.balance(auth, W2, 'live_code');
    expect(await redis.ttl(`np:prl:balnight:live:${CONN}:${W2}:2026-12-05`)).toBe(48 * 3600);
  });

  it('la noche de 23 h (29-mar-2026) y la de 25 h (25-oct-2026)', async () => {
    at('2026-03-28T07:00:00Z'); // 08:00 de Madrid: empieza la noche del 28
    await redis.set(`np:prl:balnight:ficha:${CONN}:${W1}:2026-03-28`, '20');
    expect((await refusal(limits.balance(auth, W1, 'ficha'))).retryAfter).toBe(23 * 3600);
    at('2026-10-24T06:00:00Z'); // 08:00 de Madrid (verano): empieza la noche del 24
    await redis.set(`np:prl:balnight:ficha:${CONN}:${W1}:2026-10-24`, '20');
    expect((await refusal(limits.balance(auth, W1, 'ficha'))).retryAfter).toBe(25 * 3600);
  });
});

describe('el registro de los topes (partner.limit_exceeded)', () => {
  it('uno en la 13.ª del minuto y otro en la 21.ª de la noche, ninguno en la 22.ª', async () => {
    for (let i = 0; i < 13; i += 1) await limits.balance(auth, W1, 'ficha').catch(() => undefined);
    expect(actions()).toEqual([
      expect.objectContaining({
        action: 'partner.limit_exceeded',
        tenantId: 'venue-a',
        targetType: 'ClientWallet',
        targetId: W1,
        payload: { connectionId: CONN, keyHint: 'oxp_test_…a1b2', name: 'Cajeros Demo', limit: 'balance_minute', refKind: 'ficha' },
      }),
    ]);
    at('2026-12-05T22:42:05Z');
    for (let i = 0; i < 8; i += 1) await limits.balance(auth, W1, 'ficha');
    await refusal(limits.balance(auth, W1, 'ficha')); // la 21.ª de la noche
    at('2026-12-05T22:43:05Z');
    await refusal(limits.balance(auth, W1, 'ficha')); // la 22.ª
    expect(actions().map((a) => a.payload.limit)).toEqual(['balance_minute', 'balance_night']);
  });

  it('si Redis no puede marcar el primero, se registra igual', async () => {
    for (let i = 0; i < 12; i += 1) await limits.balance(auth, W1, 'ficha');
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('ECONNRESET'));
    await refusal(limits.balance(auth, W1, 'ficha'));
    expect(actions()).toHaveLength(1);
  });
});

describe('el freno de textos raros: 30 por minuto', () => {
  it('el 31.º, 429 con un solo registro partner.qr_scanning', async () => {
    for (let i = 0; i < 30; i += 1) await limits.scan(auth);
    const err = await refusal(limits.scan(auth));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(55);
    await refusal(limits.scan(auth));
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      action: 'partner.qr_scanning',
      tenantId: 'venue-a',
      targetType: 'PartnerConnection',
      targetId: CONN,
      payload: { connectionId: CONN, keyHint: 'oxp_test_…a1b2' },
    });
    // Las lecturas de saldo no pasan por el freno.
    await expect(limits.balance(auth, W1, 'live_code')).resolves.toBeUndefined();
  });
});

describe('Redis que falla', () => {
  it('503 try_later con Retry-After 5, en el freno y en las lecturas', async () => {
    vi.spyOn(redis, 'incr').mockRejectedValue(new Error('ECONNREFUSED'));
    for (const p of [limits.scan(auth), limits.balance(auth, W1, 'ficha')]) {
      const err = await refusal(p);
      expect(err.code).toBe('try_later');
      expect(err.retryAfter).toBe(5);
    }
  });
});
