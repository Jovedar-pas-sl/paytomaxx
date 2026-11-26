import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { PartnerKeySweepService } from './partner-key-sweep.service';

const NOW = new Date('2026-12-05T10:00:00Z');
const DAY = 86_400_000;

/** Una base de mentira compartida por las dos réplicas: el UPDATE … RETURNING devuelve cada fila una sola vez. */
function sharedDb() {
  const rows = [
    { id: 'c1', tenantId: 't1', keyHint: 'oxp_live_…a1b2', scopes: ['wallet:load'], name: 'Cajeros', sealed: 'k1:abc', claimExpiresAt: new Date(NOW.getTime() - 1000) },
    { id: 'c2', tenantId: 't1', keyHint: 'oxp_live_…c3d4', scopes: ['wallet:load'], name: 'Cajeros', sealed: 'k1:def', claimExpiresAt: new Date(NOW.getTime() + 1000) },
  ];
  const expiring = [
    { id: 'c3', tenantId: 't2', keyHint: 'oxp_live_…e5f6', scopes: ['wallet:load'], keyCreatedAt: new Date(NOW.getTime() - 340 * DAY), keyExpiresAt: new Date(NOW.getTime() + 25 * DAY), partner: { name: 'Cajeros' } },
  ];
  return {
    rows,
    tx: {
      $queryRaw: vi.fn(async () => {
        const out = rows.filter((r) => r.sealed !== null && r.claimExpiresAt < NOW);
        for (const r of out) r.sealed = null;
        return out.map(({ id, tenantId, keyHint, scopes, name }) => ({ id, tenantId, keyHint, scopes, name }));
      }),
      partnerConnection: { findMany: vi.fn(async () => expiring) },
    },
  };
}

function replica(db: ReturnType<typeof sharedDb>, redis: ReturnType<typeof createFakeRedis>, audit: { log: ReturnType<typeof vi.fn>; logInTx: ReturnType<typeof vi.fn> }) {
  const prisma = { asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db.tx)) };
  return new PartnerKeySweepService(prisma as never, redis as never, audit as never);
}

afterEach(() => vi.unstubAllEnvs());

describe('repaso de las claves', () => {
  it('dos réplicas a la vez: cada enlace caducado se borra y se registra una sola vez, y el aviso de caducidad sale una vez', async () => {
    const db = sharedDb();
    const redis = createFakeRedis();
    const audit = { log: vi.fn(async () => undefined), logInTx: vi.fn(async () => undefined) };
    await Promise.all([replica(db, redis, audit).tick(NOW), replica(db, redis, audit).tick(NOW)]);
    const expired = audit.logInTx.mock.calls.filter(([, e]) => (e as { action: string }).action === 'partner.key.claim_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]![1]).toMatchObject({ tenantId: 't1', targetId: 'c1', payload: { connectionId: 'c1', keyHint: 'oxp_live_…a1b2', name: 'Cajeros', scopes: ['wallet:load'] } });
    expect(db.rows.map((r) => r.sealed)).toEqual([null, 'k1:def']);
    const expiring = audit.log.mock.calls.filter(([e]) => (e as { action: string }).action === 'partner.key.expiring');
    expect(expiring).toHaveLength(1);
    expect(expiring[0]![0]).toMatchObject({ tenantId: 't2', payload: { connectionId: 'c3', days: 30 } });
  });

  it('el aviso de los 7 días es otro y también sale una sola vez', async () => {
    const db = sharedDb();
    const redis = createFakeRedis();
    const audit = { log: vi.fn(async () => undefined), logInTx: vi.fn(async () => undefined) };
    const service = replica(db, redis, audit);
    await service.tick(NOW);
    const later = new Date(NOW.getTime() + 19 * DAY);
    await service.tick(later);
    await service.tick(later);
    const days = audit.log.mock.calls.map(([e]) => (e as { payload: { days: number } }).payload.days);
    expect(days).toEqual([30, 7]);
  });

  it('no corre en pruebas, con la API apagada ni con NIGHTPAY_DISABLE_PARTNER_SWEEP=1', () => {
    const make = () => replica(sharedDb(), createFakeRedis(), { log: vi.fn(), logInTx: vi.fn() });
    const spy = vi.spyOn(globalThis, 'setInterval');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PARTNER_API_ENABLED', 'false');
    make().onModuleInit();
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('PARTNER_API_MODE', 'live');
    vi.stubEnv('NIGHTPAY_DISABLE_PARTNER_SWEEP', '1');
    make().onModuleInit();
    vi.stubEnv('NIGHTPAY_DISABLE_PARTNER_SWEEP', '');
    vi.stubEnv('NODE_ENV', 'test');
    make().onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    vi.stubEnv('NODE_ENV', 'production');
    const on = make();
    on.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    on.onModuleDestroy();
    spy.mockRestore();
  });
});
