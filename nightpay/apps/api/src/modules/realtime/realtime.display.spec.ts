import { describe, it, expect, vi } from 'vitest';
import { DISPLAY_READ_ONLY_ERROR, RealtimeGateway } from './realtime.gateway';
import { AccessRevocationService } from '../auth/access-revocation.service';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { sha256 } from '../customer-display/display-code';

const DISPLAY_TOKEN = 'a'.repeat(43);
const DISPLAY_ID = '7d0f4f9e-0000-4000-8000-0000000000dd';
const PAY = '7d0f4f9e-0000-4000-8000-000000000001';
const CHARGE = '7d0f4f9e-0000-4000-8000-000000000002';

function makeClient(auth: Record<string, unknown>) {
  const rooms = new Set<string>(['sock-1']);
  return {
    id: 'sock-1',
    handshake: { auth, headers: {} },
    data: {} as Record<string, unknown>,
    rooms,
    join: vi.fn(async (room: string | string[]) => {
      for (const r of [room].flat()) rooms.add(r);
    }),
    leave: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeGateway() {
  const displays: Record<string, unknown> = {
    [sha256(DISPLAY_TOKEN)]: {
      id: DISPLAY_ID,
      tenantId: 't1',
      userId: 'u1',
      pairedAt: new Date(Date.now() - 60_000),
      tipCents: 0,
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
      paymentId: PAY,
      chargeId: CHARGE,
      clearedAt: null,
      lastSeenAt: null,
      user: { deletedAt: null, role: 'WAITER' },
    },
  };
  const findDisplay = vi.fn(({ where }: { where: { tokenHash: string } }) => Promise.resolve(displays[where.tokenHash] ?? null));
  const findPayment = vi.fn(() => Promise.resolve({ tenantId: 't1', createdAt: new Date() }));
  const prisma = {
    asSystem: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({
        customerDisplay: { findUnique: findDisplay },
        payment: { findUnique: findPayment },
        venueNight: { findFirst: vi.fn(() => Promise.resolve(null)) },
      }),
    ),
  };
  const jwt = { verifyAsync: vi.fn(() => Promise.reject(new Error('invalid'))) };
  const metrics = { wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() }, wsLegacySubscribes: { inc: vi.fn() } };
  const revocations = new AccessRevocationService(createFakeRedis() as never);
  const gateway = new RealtimeGateway(jwt as never, prisma as never, metrics as never, revocations);
  const roomOps = { socketsJoin: vi.fn(), socketsLeave: vi.fn(), disconnectSockets: vi.fn() };
  const emit = vi.fn();
  const server = { in: vi.fn(() => roomOps), to: vi.fn(() => ({ emit })) };
  gateway.server = server as never;
  return { gateway, server, roomOps, emit, findPayment };
}

describe('RealtimeGateway: la pantalla del cliente', () => {
  it('con su credencial entra en su sala y en la de su cobro (sin JWT)', async () => {
    const g = makeGateway();
    const client = makeClient({ displayToken: DISPLAY_TOKEN });
    await g.gateway.handleConnection(client as never);
    expect(client.data.display).toEqual({ id: DISPLAY_ID });
    expect(client.data.staff).toBeUndefined();
    expect([...client.rooms]).toEqual(
      expect.arrayContaining([`display:${DISPLAY_ID}`, `payment:${PAY}`, `wallet-charge:${CHARGE}`]),
    );
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('credencial que no vale: fuera (no baja a la vía antigua sin sesión)', async () => {
    const g = makeGateway();
    const client = makeClient({ displayToken: 'b'.repeat(43) });
    await g.gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.data.display).toBeUndefined();
  });

  it('no puede suscribirse a ningún cobro ni cobro del saldo: solo ve el suyo', async () => {
    const g = makeGateway();
    const client = makeClient({ displayToken: DISPLAY_TOKEN });
    await g.gateway.handleConnection(client as never);
    const other = '7d0f4f9e-0000-4000-8000-000000000009';
    expect(await g.gateway.handleSubscribe({ paymentId: other }, client as never)).toEqual({
      ok: false,
      error: DISPLAY_READ_ONLY_ERROR,
    });
    expect(await g.gateway.handleWalletChargeSubscribe({ chargeId: other }, client as never)).toEqual({
      ok: false,
      error: DISPLAY_READ_ONLY_ERROR,
    });
    expect(client.rooms.has(`payment:${other}`)).toBe(false);
    expect(g.findPayment).not.toHaveBeenCalled();
  });

  it('cambio de cobro: deja la sala del anterior, entra en la del nuevo y avisa', () => {
    const g = makeGateway();
    g.gateway.showOnDisplay(DISPLAY_ID, ['payment:new'], ['payment:old']);
    expect(g.server.in).toHaveBeenCalledWith(`display:${DISPLAY_ID}`);
    expect(g.roomOps.socketsLeave).toHaveBeenCalledWith(['payment:old']);
    expect(g.roomOps.socketsJoin).toHaveBeenCalledWith(['payment:new']);
    expect(g.server.to).toHaveBeenCalledWith(`display:${DISPLAY_ID}`);
    expect(g.emit).toHaveBeenCalledWith('display:update', expect.objectContaining({ type: 'display:update' }));
  });

  it('desemparejada: aviso y conexiones cortadas', () => {
    const g = makeGateway();
    g.gateway.closeDisplay(DISPLAY_ID);
    expect(g.emit).toHaveBeenCalledWith('display:update', expect.anything());
    expect(g.roomOps.disconnectSockets).toHaveBeenCalledWith(true);
  });
});
