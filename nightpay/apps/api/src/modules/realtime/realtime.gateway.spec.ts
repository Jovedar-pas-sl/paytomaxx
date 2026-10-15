import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeGateway, MAX_ROOMS_PER_SOCKET, LEGACY_SUBSCRIBE_WINDOW_MS } from './realtime.gateway';

const TENANT_A = '7d0f4f9e-0000-4000-8000-0000000000aa';
const TENANT_B = '7d0f4f9e-0000-4000-8000-0000000000bb';
const PAY_A = '7d0f4f9e-0000-4000-8000-000000000001';
const PAY_B = '7d0f4f9e-0000-4000-8000-000000000002';
const PAY_OLD = '7d0f4f9e-0000-4000-8000-000000000003';

const STAFF = {
  sub: '7d0f4f9e-0000-4000-8000-0000000000cc',
  email: 'enc@local.es',
  role: 'MANAGER',
  tenantId: TENANT_A,
  venueSlug: 'luna',
};

function makeClient(auth: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const rooms = new Set<string>(['sock-1']);
  return {
    id: 'sock-1',
    handshake: { auth, headers },
    data: {} as Record<string, unknown>,
    rooms,
    join: vi.fn(async (room: string) => {
      rooms.add(room);
    }),
    leave: vi.fn(async (room: string) => {
      rooms.delete(room);
    }),
  };
}

function makeGateway() {
  const payments: Record<string, { tenantId: string; createdAt: Date }> = {
    [PAY_A]: { tenantId: TENANT_A, createdAt: new Date() },
    [PAY_B]: { tenantId: TENANT_B, createdAt: new Date() },
    [PAY_OLD]: { tenantId: TENANT_A, createdAt: new Date(Date.now() - LEGACY_SUBSCRIBE_WINDOW_MS - 60_000) },
  };
  const findUnique = vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(payments[where.id] ?? null));
  const prisma = { asSystem: vi.fn((fn: (tx: unknown) => unknown) => fn({ payment: { findUnique } })) };
  const jwt = {
    verifyAsync: vi.fn((token: string) =>
      token === 'buen-token' ? Promise.resolve(STAFF) : Promise.reject(new Error('invalid signature')),
    ),
  };
  const metrics = { wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() } };
  const gateway = new RealtimeGateway(jwt as never, prisma as never, metrics as never);
  return { gateway, findUnique, metrics };
}

describe('RealtimeGateway: suscripción a un cobro', () => {
  let g: ReturnType<typeof makeGateway>;
  beforeEach(() => {
    g = makeGateway();
  });

  it('con sesión del personal (handshake.auth.token): solo cobros de su local', async () => {
    const client = makeClient({ token: 'buen-token' });
    await g.gateway.handleConnection(client as never);
    await expect(g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never)).resolves.toEqual({
      ok: true,
      room: `payment:${PAY_A}`,
    });
    const otroLocal = await g.gateway.handleSubscribe({ paymentId: PAY_B }, client as never);
    expect(otroLocal.ok).toBe(false);
    expect(client.rooms.has(`payment:${PAY_B}`)).toBe(false);
  });

  it('también con Authorization: Bearer en el handshake', async () => {
    const client = makeClient({}, { authorization: 'Bearer buen-token' });
    await g.gateway.handleConnection(client as never);
    expect((await g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never)).ok).toBe(true);
  });

  it('el id tiene que ser un UUID', async () => {
    const client = makeClient({ token: 'buen-token' });
    await g.gateway.handleConnection(client as never);
    for (const bad of [{ paymentId: 'x' }, { paymentId: `${PAY_A}' OR 1=1` }, {}, null]) {
      expect((await g.gateway.handleSubscribe(bad as never, client as never)).ok).toBe(false);
    }
    expect(g.findUnique).not.toHaveBeenCalled();
  });

  it(`como mucho ${MAX_ROOMS_PER_SOCKET} cobros por conexión`, async () => {
    const client = makeClient({ token: 'buen-token' });
    await g.gateway.handleConnection(client as never);
    for (let i = 0; i < MAX_ROOMS_PER_SOCKET; i++) client.rooms.add(`payment:otro-${i}`);
    const res = await g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never);
    expect(res.ok).toBe(false);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('sin sesión (apps antiguas): solo cobros recientes, y queda avisado', async () => {
    const client = makeClient();
    await g.gateway.handleConnection(client as never);
    expect((await g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never)).ok).toBe(true);
    expect((await g.gateway.handleSubscribe({ paymentId: PAY_OLD }, client as never)).ok).toBe(false);
    expect((await g.gateway.handleSubscribe({ paymentId: '7d0f4f9e-0000-4000-8000-0000000000ff' }, client as never)).ok).toBe(false);
  });

  it('un subscribe que llega antes de comprobar la sesión espera a la comprobación', async () => {
    const client = makeClient({ token: 'buen-token' });
    const connecting = g.gateway.handleConnection(client as never); // sin await: aún verificando
    // Cobro de otro local, reciente: por la vía sin sesión pasaría; con la sesión, no.
    const res = await g.gateway.handleSubscribe({ paymentId: PAY_B }, client as never);
    await connecting;
    expect(res.ok).toBe(false);
    expect(client.rooms.has(`payment:${PAY_B}`)).toBe(false);
  });

  it('token inválido: como sin sesión (no da acceso a otros locales)', async () => {
    const client = makeClient({ token: 'malo' });
    await g.gateway.handleConnection(client as never);
    expect(client.data.staff).toBeUndefined();
    expect((await g.gateway.handleSubscribe({ paymentId: PAY_OLD }, client as never)).ok).toBe(false);
  });

  it('cuenta las conexiones activas', async () => {
    const client = makeClient();
    await g.gateway.handleConnection(client as never);
    g.gateway.handleDisconnect();
    expect(g.metrics.wsConnectionsActive.inc).toHaveBeenCalled();
    expect(g.metrics.wsConnectionsActive.dec).toHaveBeenCalled();
  });

  it('unsubscribe valida el id', async () => {
    const client = makeClient({ token: 'buen-token' });
    await g.gateway.handleConnection(client as never);
    await g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never);
    expect(await g.gateway.handleUnsubscribe({ paymentId: PAY_A }, client as never)).toEqual({ ok: true });
    expect(client.rooms.has(`payment:${PAY_A}`)).toBe(false);
    expect((await g.gateway.handleUnsubscribe({ paymentId: 'x' } as never, client as never)).ok).toBe(false);
  });
});
