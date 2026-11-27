import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedis, type FakeRedis } from '../../auth/testing/fake-redis';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { PARTNER_LOAD_AUDIT, PartnerLoadWatch, type LoadRefused } from './partner-load-watch';

/**
 * La vigilancia de las cargas (A9) con un Redis en memoria y el reloj falso:
 * los rechazos `per_operation` en 10 minutos deslizantes (la misma petición
 * repetida cuenta uno), la 3.ª anulación de la API en la noche (las del panel
 * no las cuenta la consulta) y el efectivo troceado sin `device`.
 */

const sql = vi.hoisted(() => ({
  loadsSince: vi.fn(async () => 0),
  apiVoidsSince: vi.fn(async () => 0),
  deviceCashSince: vi.fn(async () => ({ wallets: 0, total: 0 })),
}));
vi.mock('./partner-loads.sql', () => sql);
vi.mock('../../../common/observability/sentry', () => ({ reportError: vi.fn() }));

const T0 = new Date('2026-12-05T22:00:00Z');
const MIN = 60_000;

const auth = {
  connection: {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    keyHint: 'oxp_test_…cdef',
    scopes: ['wallet:balance', 'wallet:load'],
    loadNightMaxCents: 500000,
    partner: { name: 'Cajeros Demo' },
  },
  keyHint: 'oxp_test_…cdef',
} as unknown as PartnerAuth;

let redis: FakeRedis;
let audit: { log: ReturnType<typeof vi.fn>; logInTx: ReturnType<typeof vi.fn> };
let pausedWith: string[];
let watch: PartnerLoadWatch;

function makeWatch(): PartnerLoadWatch {
  const tx = {
    $queryRaw: vi.fn(async () => [{ status: 'ACTIVE', scopes: ['wallet:balance', 'wallet:load'], pausedScopes: pausedWith.length ? ['wallet:load'] : [] }]),
    partnerConnection: {
      update: vi.fn(async (args: { data: { pausedReason: string } }) => {
        pausedWith.push(args.data.pausedReason);
        return {};
      }),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return new PartnerLoadWatch(prisma as never, redis as never, audit as never);
}

const refusal = (over: Partial<LoadRefused> = {}): LoadRefused => ({
  walletId: 'w1',
  limit: 'per_operation',
  amountCents: 40000,
  idempotencyKey: `ATM0042-${Math.random().toString(36).slice(2, 10)}`,
  requestHash: 'a'.repeat(64),
  now: new Date(),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  redis = createFakeRedis();
  audit = { log: vi.fn(async () => undefined), logInTx: vi.fn(async () => undefined) };
  pausedWith = [];
  sql.loadsSince.mockResolvedValue(0);
  sql.apiVoidsSince.mockResolvedValue(0);
  sql.deviceCashSince.mockResolvedValue({ wallets: 0, total: 0 });
  watch = makeWatch();
});

afterEach(() => {
  vi.useRealTimers();
});

async function refuseAt(minutesFromStart: number, over: Partial<LoadRefused> = {}): Promise<void> {
  vi.setSystemTime(new Date(T0.getTime() + minutesFromStart * MIN));
  await watch.refused(auth, refusal({ now: new Date(), ...over }));
}

describe('pausa por 3 rechazos per_operation en 10 minutos deslizantes', () => {
  it('a los 0, 1 y 9:59 minutos: pausa (load_refusals), una vez y con su registro', async () => {
    await refuseAt(0);
    await refuseAt(1);
    expect(pausedWith).toEqual([]);
    await refuseAt(9 + 59 / 60);
    expect(pausedWith).toEqual(['load_refusals']);
    expect(audit.logInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'partner.connection.paused', payload: expect.objectContaining({ reason: 'load_refusals' }) }),
    );
    // Ya en pausa: la 4.ª no vuelve a pausar.
    await refuseAt(10);
    expect(pausedWith).toEqual(['load_refusals']);
  });

  it('a los 0, 0:30 y 11 minutos: no (el primero ya salió de la ventana)', async () => {
    await refuseAt(0);
    await refuseAt(0.5);
    await refuseAt(11);
    expect(pausedWith).toEqual([]);
  });

  it('la misma petición repetida (misma clave y huella) cuenta una vez', async () => {
    const same = { idempotencyKey: 'ATM0042-20261205-000731-K7QM', requestHash: 'b'.repeat(64) };
    await refuseAt(0, same);
    await refuseAt(1, same);
    await refuseAt(2, same);
    expect(pausedWith).toEqual([]);
    await refuseAt(3, { requestHash: 'c'.repeat(64), idempotencyKey: same.idempotencyKey });
    await refuseAt(4);
    expect(pausedWith).toEqual(['load_refusals']);
  });

  it('los demás topes no cuentan para la pausa', async () => {
    for (const [i, limit] of (['wallet_24h', 'wallet_24h_all_partners', 'unnamed_wallet_30d', 'connection_night', 'cash'] as const).entries()) {
      await refuseAt(i, { limit });
    }
    expect(pausedWith).toEqual([]);
  });

  it('partner.limit_exceeded: el primero por saldo y tope al registro; el primero de la noche, al dueño (ownerAlert)', async () => {
    await refuseAt(0);
    await refuseAt(1);
    await refuseAt(2, { walletId: 'w2' });
    const rows = audit.log.mock.calls.map(([a]) => a).filter((a) => a.action === PARTNER_LOAD_AUDIT.limitExceeded);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ targetId: 'w1', payload: { limit: 'per_operation', amountCents: 40000, ownerAlert: true, name: 'Cajeros Demo' } });
    expect(rows[1].payload.ownerAlert).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('ATM0042');
  });

  it('un fallo de Redis no pausa ni lanza (al log)', async () => {
    redis.zadd = vi.fn(async () => {
      throw new Error('Redis caído');
    }) as never;
    await expect(watch.refused(auth, refusal())).resolves.toBeUndefined();
    expect(pausedWith).toEqual([]);
  });
});

describe('pausa por anulaciones y por ráfaga', () => {
  it('la 3.ª anulación de la API en la noche pausa (load_voids); con 2, no', async () => {
    sql.apiVoidsSince.mockResolvedValue(2);
    await watch.apiVoided(auth, new Date());
    expect(pausedWith).toEqual([]);
    sql.apiVoidsSince.mockResolvedValue(3);
    await watch.apiVoided(auth, new Date());
    expect(pausedWith).toEqual(['load_voids']);
    // Desde las 08:00 de Madrid de esa noche.
    expect(sql.apiVoidsSince).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ since: new Date('2026-12-05T07:00:00Z') }));
  });

  it('más de 30 cargas nuevas en un minuto pausan (load_burst); 30, no', async () => {
    const load = { walletId: 'w1', amountCents: 2000, device: 'ATM0042', nightTotalCents: 2000, nightCapCents: 500000, now: new Date() };
    sql.loadsSince.mockResolvedValue(30);
    await watch.loaded(auth, load);
    expect(pausedWith).toEqual([]);
    sql.loadsSince.mockResolvedValue(31);
    await watch.loaded(auth, load);
    expect(pausedWith).toEqual(['load_burst']);
  });
});

describe('avisos de la noche y del efectivo troceado', () => {
  const load = (over: Record<string, unknown> = {}) => ({
    walletId: 'w1',
    amountCents: 20000,
    device: null as string | null,
    nightTotalCents: 20000,
    nightCapCents: 500000,
    now: new Date(),
    ...over,
  });
  const actions = () => audit.log.mock.calls.map(([a]) => a.action);

  it('la mitad y el total del tope de la noche: un aviso cada uno por noche', async () => {
    await watch.loaded(auth, load({ nightTotalCents: 240000 }));
    expect(actions()).toEqual([]);
    await watch.loaded(auth, load({ nightTotalCents: 260000 }));
    await watch.loaded(auth, load({ nightTotalCents: 280000 }));
    expect(actions()).toEqual([PARTNER_LOAD_AUDIT.nightHalf]);
    await watch.loaded(auth, load({ nightTotalCents: 500000 }));
    await watch.loaded(auth, load({ nightTotalCents: 500000, amountCents: 1 }));
    expect(actions()).toEqual([PARTNER_LOAD_AUDIT.nightHalf, PARTNER_LOAD_AUDIT.nightFull]);
  });

  it('el total también con el primer connection_night', async () => {
    await watch.refused(auth, refusal({ limit: 'connection_night' }));
    expect(actions()).toContain(PARTNER_LOAD_AUDIT.nightFull);
  });

  it('troceo sin `device`: las cargas sin cajero, juntas; un aviso por cajero y noche', async () => {
    sql.deviceCashSince.mockResolvedValue({ wallets: 1, total: 120000 });
    await watch.loaded(auth, load());
    expect(actions()).not.toContain(PARTNER_LOAD_AUDIT.cashSplit);
    sql.deviceCashSince.mockResolvedValue({ wallets: 3, total: 99999 });
    await watch.loaded(auth, load());
    expect(actions()).not.toContain(PARTNER_LOAD_AUDIT.cashSplit);
    sql.deviceCashSince.mockResolvedValue({ wallets: 3, total: 100000 });
    await watch.loaded(auth, load());
    await watch.loaded(auth, load());
    expect(actions().filter((a) => a === PARTNER_LOAD_AUDIT.cashSplit)).toHaveLength(1);
    expect(sql.deviceCashSince).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ device: null }));
    // Otro cajero, su propio aviso.
    await watch.loaded(auth, load({ device: 'ATM0042' }));
    expect(actions().filter((a) => a === PARTNER_LOAD_AUDIT.cashSplit)).toHaveLength(2);
  });
});
