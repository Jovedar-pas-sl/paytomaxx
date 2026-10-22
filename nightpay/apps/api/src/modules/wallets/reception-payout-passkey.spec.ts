import { describe, expect, it } from 'vitest';
import { PAYOUT_PASSKEY_TTL_SECONDS } from '@nightpay/contracts';
import { ReceptionPayoutPasskeys, isPayoutPasskeyToken, payoutPasskeyScope } from './reception-payout-passkey';

/** Redis de mentira: get/set con EX o PX y pttl, con un reloj que se puede mover. */
function fakeRedis() {
  let now = 0;
  const store = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const row = store.get(key);
    if (!row || row.until <= now) {
      store.delete(key);
      return null;
    }
    return row;
  };
  return {
    advance: (ms: number) => { now += ms; },
    get: async (key: string) => live(key)?.value ?? null,
    set: async (key: string, value: string, mode: 'EX' | 'PX', ttl: number) => {
      store.set(key, { value, until: now + (mode === 'EX' ? ttl * 1000 : ttl) });
      return 'OK';
    },
    pttl: async (key: string) => {
      const row = live(key);
      return row ? row.until - now : -2;
    },
  };
}

const base = { walletId: 'w-1', tenantId: 't-1', userId: 'u-1', requestKey: 'salida-0001', amountCents: 3_500, venueName: 'Luna' };

describe('QR de la salida con Face ID', () => {
  it('una petición por requestKey: la misma salida repite su QR; caduca a los 5 minutos', async () => {
    const redis = fakeRedis();
    const store = new ReceptionPayoutPasskeys(redis as never);
    const first = await store.open(base, new Date('2026-10-23T02:00:00Z'));
    expect(isPayoutPasskeyToken(first.token)).toBe(true);
    expect(first.request).toMatchObject({ ...base, confirmed: false, expiresAt: '2026-10-23T02:05:00.000Z' });
    expect((await store.open(base)).token).toBe(first.token);
    expect((await store.byRequestKey('t-1', 'salida-0001'))?.token).toBe(first.token);
    redis.advance(PAYOUT_PASSKEY_TTL_SECONDS * 1000);
    expect(await store.byToken(first.token)).toBeNull();
    expect(await store.byRequestKey('t-1', 'salida-0001')).toBeNull();
  });

  it('otro importe u otra persona con la misma requestKey: otro QR (quien llama lo rechaza)', async () => {
    const store = new ReceptionPayoutPasskeys(fakeRedis() as never);
    const first = await store.open(base);
    expect((await store.open({ ...base, amountCents: 1_000 })).token).not.toBe(first.token);
  });

  it('confirmarla la deja confirmada hasta que caduque (sin alargarla)', async () => {
    const redis = fakeRedis();
    const store = new ReceptionPayoutPasskeys(redis as never);
    const { token } = await store.open(base);
    redis.advance(60_000);
    expect(await store.markConfirmed(token)).toMatchObject({ confirmed: true });
    expect(await store.byToken(token)).toMatchObject({ confirmed: true });
    redis.advance((PAYOUT_PASSKEY_TTL_SECONDS - 60) * 1000);
    expect(await store.byToken(token)).toBeNull();
    expect(await store.markConfirmed(token)).toBeNull();
  });

  it('tokens raros o datos rotos no valen', async () => {
    const redis = fakeRedis();
    const store = new ReceptionPayoutPasskeys(redis as never);
    expect(await store.byToken('../../etc')).toBeNull();
    await redis.set('np:rpo:tok:AAAAAAAAAAAAAAAAAAAAAAAA', '{roto', 'EX', 60);
    expect(await store.byToken('AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    await redis.set('np:rpo:tok:BBBBBBBBBBBBBBBBBBBBBBBB', JSON.stringify({ walletId: 'w' }), 'EX', 60);
    expect(await store.byToken('BBBBBBBBBBBBBBBBBBBBBBBB')).toBeNull();
  });

  it('el reto vale solo para esa salida', () => {
    expect(payoutPasskeyScope('w-1', 'salida-0001')).toBe('payout:w-1:salida-0001');
  });
});
