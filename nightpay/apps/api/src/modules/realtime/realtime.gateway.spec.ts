import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  RealtimeGateway,
  MAX_ROOMS_PER_SOCKET,
  LEGACY_SUBSCRIBE_CLOSED_ERROR,
  LEGACY_SUBSCRIBE_WINDOW_MS,
} from './realtime.gateway';

/** Antes de la fecha de corte por defecto (2026-11-15 00:00 de Madrid). */
const BEFORE_CUTOFF = new Date('2026-10-20T12:00:00+02:00');

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

function makeClient(auth: Record<string, unknown> = {}, headers: Record<string, string> = {}, id = 'sock-1') {
  const rooms = new Set<string>([id]);
  return {
    id,
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

/** `legacyUntil`: valor de REALTIME_LEGACY_SUBSCRIBE_UNTIL (sin definir = el de por defecto). */
function makeGateway(legacyUntil?: string) {
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
  const metrics = { wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() }, wsLegacySubscribes: { inc: vi.fn() } };
  const config = { get: vi.fn((key: string) => (key === 'REALTIME_LEGACY_SUBSCRIBE_UNTIL' ? legacyUntil : undefined)) };
  const gateway = new RealtimeGateway(jwt as never, prisma as never, metrics as never, config as never);
  return { gateway, findUnique, metrics };
}

describe('RealtimeGateway: suscripción a un cobro', () => {
  let g: ReturnType<typeof makeGateway>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_CUTOFF);
    g = makeGateway();
  });
  afterEach(() => vi.useRealTimers());

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

describe('RealtimeGateway: la vía sin sesión se apaga sola (REALTIME_LEGACY_SUBSCRIBE_UNTIL)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  /** Pone la hora y crea el gateway (los cobros de prueba se crean "ahora"). */
  function at(iso: string, legacyUntil?: string) {
    vi.setSystemTime(new Date(iso));
    return makeGateway(legacyUntil);
  }

  async function subscribeWithoutSession(g: ReturnType<typeof makeGateway>, client = makeClient()) {
    await g.gateway.handleConnection(client as never);
    return g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never);
  }

  const closedLogs = () => warn.mock.calls.filter(([msg]) => String(msg).includes('rechazado'));

  it('antes del corte (por defecto 2026-11-15 00:00 de Madrid): sigue valiendo y se cuenta', async () => {
    const g = at('2026-11-14T23:59:59+01:00');
    expect(await subscribeWithoutSession(g)).toEqual({ ok: true, room: `payment:${PAY_A}` });
    expect(g.metrics.wsLegacySubscribes.inc).toHaveBeenCalledWith({ result: 'allowed' });

    const old = makeClient({}, {}, 'sock-old');
    await g.gateway.handleConnection(old as never);
    expect((await g.gateway.handleSubscribe({ paymentId: PAY_OLD }, old as never)).ok).toBe(false);
    expect(g.metrics.wsLegacySubscribes.inc).toHaveBeenCalledWith({ result: 'denied' });
  });

  it('desde el corte: «Inicia sesión otra vez», sin mirar el cobro, y un solo aviso en el log por conexión', async () => {
    const g = at('2026-11-15T00:00:00+01:00');
    const client = makeClient();
    expect(await subscribeWithoutSession(g, client)).toEqual({ ok: false, error: LEGACY_SUBSCRIBE_CLOSED_ERROR });
    expect(LEGACY_SUBSCRIBE_CLOSED_ERROR).toBe('Inicia sesión otra vez');
    expect(await g.gateway.handleSubscribe({ paymentId: PAY_B }, client as never)).toEqual({
      ok: false,
      error: LEGACY_SUBSCRIBE_CLOSED_ERROR,
    });
    expect(client.join).not.toHaveBeenCalled();
    expect(g.findUnique).not.toHaveBeenCalled();
    expect(closedLogs()).toHaveLength(1);
    expect(g.metrics.wsLegacySubscribes.inc).toHaveBeenCalledTimes(2);
    expect(g.metrics.wsLegacySubscribes.inc).toHaveBeenCalledWith({ result: 'closed' });

    await subscribeWithoutSession(g, makeClient({}, {}, 'sock-2'));
    expect(closedLogs()).toHaveLength(2);
  });

  it('desde el corte, con la sesión del personal todo sigue igual', async () => {
    const g = at('2026-12-01T10:00:00+01:00');
    const client = makeClient({ token: 'buen-token' });
    await g.gateway.handleConnection(client as never);
    expect(await g.gateway.handleSubscribe({ paymentId: PAY_A }, client as never)).toEqual({
      ok: true,
      room: `payment:${PAY_A}`,
    });
    expect(g.metrics.wsLegacySubscribes.inc).not.toHaveBeenCalled();
  });

  it('se puede cambiar la fecha con la variable (más tarde)', async () => {
    const until = '2026-12-01T00:00:00+01:00';
    expect((await subscribeWithoutSession(at('2026-11-20T12:00:00+01:00', until))).ok).toBe(true);
    expect(await subscribeWithoutSession(at('2026-12-01T00:00:01+01:00', until))).toEqual({
      ok: false,
      error: LEGACY_SUBSCRIBE_CLOSED_ERROR,
    });
  });

  it('"off": apagada ya, aunque no haya llegado la fecha', async () => {
    const g = at(BEFORE_CUTOFF.toISOString(), 'off');
    expect(await subscribeWithoutSession(g)).toEqual({ ok: false, error: LEGACY_SUBSCRIBE_CLOSED_ERROR });
    expect(g.metrics.wsLegacySubscribes.inc).toHaveBeenCalledWith({ result: 'closed' });
  });

  it('un valor que no es fecha con zona no arranca (lo frena también la validación del entorno)', () => {
    vi.setSystemTime(BEFORE_CUTOFF);
    expect(() => makeGateway('15/11/2026')).toThrow(/REALTIME_LEGACY_SUBSCRIBE_UNTIL/);
  });
});
