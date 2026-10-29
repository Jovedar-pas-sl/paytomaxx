import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RealtimeGateway,
  MAX_ROOMS_PER_SOCKET,
  LEGACY_SUBSCRIBE_CLOSED_ERROR,
  SESSION_EXPIRED_ERROR,
  SESSION_REVOKED_ERROR,
} from './realtime.gateway';
import { AccessRevocationService } from '../auth/access-revocation.service';
import { createFakeRedis } from '../auth/testing/fake-redis';

/**
 * Cobros del saldo en tiempo real para la app del personal (H-2): la misma
 * sesión y las mismas reglas que GET /v1/wallet-charges/:id (quien lo hizo,
 * o el encargado o el dueño de su local), y el aviso solo a los sockets de
 * ESTA réplica (cada réplica recibe el aviso de Postgres y avisa a los suyos).
 */

const TENANT_A = '7d0f4f9e-0000-4000-8000-0000000000aa';
const TENANT_B = '7d0f4f9e-0000-4000-8000-0000000000bb';
const CHICA = '7d0f4f9e-0000-4000-8000-0000000000c1';
const OTRA_CHICA = '7d0f4f9e-0000-4000-8000-0000000000c2';
const ENCARGADO = '7d0f4f9e-0000-4000-8000-0000000000e1';
const CHARGE_A = '7d0f4f9e-0000-4000-8000-000000000101';
const CHARGE_B = '7d0f4f9e-0000-4000-8000-000000000102';
const SID = '11111111-1111-4111-8111-111111111111';

const staff = (sub: string, role: string, tenantId = TENANT_A, extra: Record<string, unknown> = {}) => ({
  sub,
  email: `${sub.slice(-2)}@local.es`,
  role,
  tenantId,
  venueSlug: 'luna',
  ...extra,
});

const TOKENS: Record<string, Record<string, unknown>> = {
  'tok-chica': staff(CHICA, 'OPERATOR'),
  'tok-otra-chica': staff(OTRA_CHICA, 'OPERATOR'),
  'tok-encargado': staff(ENCARGADO, 'MANAGER'),
  'tok-dueno-b': staff(ENCARGADO, 'OWNER', TENANT_B),
  'tok-chica-con-sesion': staff(CHICA, 'OPERATOR', TENANT_A, { sid: SID, iat: Math.floor(Date.now() / 1000) - 60 }),
};

function makeClient(auth: Record<string, unknown> = {}, id = 'sock-1') {
  const rooms = new Set<string>([id]);
  return {
    id,
    handshake: { auth, headers: {} },
    data: {} as Record<string, unknown>,
    rooms,
    join: vi.fn(async (room: string | string[]) => {
      for (const r of [room].flat()) rooms.add(r);
    }),
    leave: vi.fn(async (room: string) => {
      rooms.delete(room);
    }),
    disconnect: vi.fn(),
  };
}

function makeGateway() {
  const charges: Record<string, { tenantId: string; requestedByUserId: string }> = {
    [CHARGE_A]: { tenantId: TENANT_A, requestedByUserId: CHICA },
    [CHARGE_B]: { tenantId: TENANT_B, requestedByUserId: OTRA_CHICA },
  };
  const findCharge = vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(charges[where.id] ?? null));
  const prisma = {
    asSystem: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ walletChargeRequest: { findUnique: findCharge }, payment: { findUnique: vi.fn(async () => null) } }),
    ),
  };
  const jwt = {
    verifyAsync: vi.fn((token: string) => {
      if (token === 'tok-1-min') return Promise.resolve({ ...staff(CHICA, 'OPERATOR'), exp: Math.floor(Date.now() / 1000) + 60 });
      const payload = TOKENS[token];
      return payload ? Promise.resolve(payload) : Promise.reject(new Error('invalid signature'));
    }),
  };
  const metrics = { wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() }, wsLegacySubscribes: { inc: vi.fn() } };
  const redis = createFakeRedis();
  const revocations = new AccessRevocationService(redis as never);
  const gateway = new RealtimeGateway(jwt as never, prisma as never, metrics as never, revocations, { get: () => undefined } as never);
  const localEmit = vi.fn();
  const clusterEmit = vi.fn();
  const server = {
    in: vi.fn(() => ({ disconnectSockets: vi.fn() })),
    to: vi.fn(() => ({ emit: clusterEmit })),
    local: { to: vi.fn(() => ({ emit: localEmit })) },
  };
  gateway.server = server as never;
  return { gateway, findCharge, server, localEmit, clusterEmit, revocations };
}

async function connected(g: ReturnType<typeof makeGateway>, token?: string) {
  const client = makeClient(token ? { token } : {});
  await g.gateway.handleConnection(client as never);
  return client;
}

describe('RealtimeGateway: wallet-charge:subscribe (cobros del saldo)', () => {
  let g: ReturnType<typeof makeGateway>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T23:00:00+01:00'));
    g = makeGateway();
  });
  afterEach(() => vi.useRealTimers());

  it('quien lo hizo: entra en la sala del cobro', async () => {
    const client = await connected(g, 'tok-chica');
    await expect(g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).resolves.toEqual({
      ok: true,
      room: `wallet-charge:${CHARGE_A}`,
    });
    expect(client.rooms.has(`wallet-charge:${CHARGE_A}`)).toBe(true);
  });

  it('el encargado de su local también (lo ve en el panel)', async () => {
    const client = await connected(g, 'tok-encargado');
    expect((await g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).ok).toBe(true);
  });

  it('otra chica del mismo local, no (ni su importe ni si se pagó): como si no existiera', async () => {
    const client = await connected(g, 'tok-otra-chica');
    await expect(g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).resolves.toEqual({
      ok: false,
      error: 'Cobro no encontrado',
    });
    expect(client.rooms.has(`wallet-charge:${CHARGE_A}`)).toBe(false);
  });

  it('de otro local, no (aunque sea su dueño allí)', async () => {
    const client = await connected(g, 'tok-dueno-b');
    expect((await g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).ok).toBe(false);
  });

  it('sin sesión: no (aquí no hay vía antigua)', async () => {
    const client = await connected(g);
    await expect(g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).resolves.toEqual({
      ok: false,
      error: LEGACY_SUBSCRIBE_CLOSED_ERROR,
    });
    expect(g.findCharge).not.toHaveBeenCalled();
  });

  it('la sesión caducó con la conexión abierta: se rechaza', async () => {
    const client = await connected(g, 'tok-1-min');
    expect((await g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).ok).toBe(true);
    vi.setSystemTime(Date.now() + 61_000);
    await expect(g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).resolves.toEqual({
      ok: false,
      error: SESSION_EXPIRED_ERROR,
    });
  });

  it('la sesión se cerró (logout): se corta la conexión', async () => {
    const client = await connected(g, 'tok-chica-con-sesion');
    await g.revocations.revokeSession(SID);
    await expect(g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).resolves.toEqual({
      ok: false,
      error: SESSION_REVOKED_ERROR,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('el id tiene que ser un UUID', async () => {
    const client = await connected(g, 'tok-chica');
    for (const bad of [{ chargeId: 'x' }, { chargeId: `${CHARGE_A}' OR 1=1` }, {}, null, { paymentId: CHARGE_A }]) {
      expect((await g.gateway.handleWalletChargeSubscribe(bad as never, client as never)).ok).toBe(false);
    }
    expect(g.findCharge).not.toHaveBeenCalled();
  });

  it(`el tope de ${MAX_ROOMS_PER_SOCKET} salas por conexión cuenta cobros con tarjeta y del saldo`, async () => {
    const client = await connected(g, 'tok-chica');
    for (let i = 0; i < MAX_ROOMS_PER_SOCKET / 2; i++) client.rooms.add(`payment:otro-${i}`);
    for (let i = 0; i < MAX_ROOMS_PER_SOCKET / 2; i++) client.rooms.add(`wallet-charge:otro-${i}`);
    expect((await g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never)).ok).toBe(false);
  });

  it('unsubscribe: sale de la sala (y valida el id)', async () => {
    const client = await connected(g, 'tok-chica');
    await g.gateway.handleWalletChargeSubscribe({ chargeId: CHARGE_A }, client as never);
    expect(await g.gateway.handleWalletChargeUnsubscribe({ chargeId: CHARGE_A }, client as never)).toEqual({ ok: true });
    expect(client.rooms.has(`wallet-charge:${CHARGE_A}`)).toBe(false);
    expect((await g.gateway.handleWalletChargeUnsubscribe({ chargeId: 'x' } as never, client as never)).ok).toBe(false);
  });
});

describe('RealtimeGateway: wallet-charge:update', () => {
  it('va a la sala del cobro y SOLO a los sockets de esta réplica (no por Redis: cada réplica ya recibió el aviso)', () => {
    const g = makeGateway();
    g.gateway.emitWalletChargeUpdate(CHARGE_A, 'ACCEPTED');
    expect(g.server.local.to).toHaveBeenCalledWith(`wallet-charge:${CHARGE_A}`);
    expect(g.localEmit).toHaveBeenCalledWith('wallet-charge:update', {
      type: 'wallet-charge:update',
      id: CHARGE_A,
      status: 'ACCEPTED',
      timestamp: expect.any(String),
    });
    expect(g.server.to).not.toHaveBeenCalled();
    expect(g.clusterEmit).not.toHaveBeenCalled();
  });

  it('sin el servidor de socket.io aún (arrancando): no revienta', () => {
    const g = makeGateway();
    g.gateway.server = undefined as never;
    expect(() => g.gateway.emitWalletChargeUpdate(CHARGE_A, 'CANCELED')).not.toThrow();
  });
});
