import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InternalServerErrorException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentDevice, DeviceGuard, type PosDevice } from './device.guard';
import { sha256 } from './paytef';

const NOW = new Date('2026-10-17T01:15:00Z');
const TENANT = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const OTRO_TENANT = 'b7e1d2c3-0000-4000-8000-00000000beef';
const TOKEN = 'dev_9fK2mQ7xL0pR4tV8yZ1bC6nH3jW5sD';
const DAY_MS = 24 * 3600 * 1000;

function terminal(o: Record<string, unknown> = {}) {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    tenantId: TENANT,
    label: 'Barra principal',
    zone: 'BARRA',
    deviceLastSeenAt: new Date(NOW.getTime() - 5_000),
    deviceTokenHash: sha256(TOKEN),
    deviceTokenIssuedAt: new Date(NOW.getTime() - DAY_MS),
    devicePairedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    ...o,
  };
}

function setup(row: ReturnType<typeof terminal> | null, opts: { clsActive?: boolean } = {}) {
  const tx = {
    terminal: {
      findFirst: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const cls = { isActive: () => opts.clsActive ?? true, get: vi.fn(() => ({ traceId: 'tr-1' })), set: vi.fn() };
  const guard = new DeviceGuard(prisma as never, cls as never);
  const req: { headers: Record<string, string | string[]>; posDevice?: PosDevice } = { headers: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  const call = (headers: Record<string, string | string[]>) => {
    req.headers = headers;
    return guard.canActivate(ctx);
  };
  return { call, req, tx, prisma, cls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('DeviceGuard — cabecera Authorization', () => {
  it.each([
    ['JWT del personal (Bearer)', { authorization: `Bearer ${TOKEN}` }],
    ['esquema en minúsculas', { authorization: `device ${TOKEN}` }],
    ['solo espacios tras Device', { authorization: 'Device    ' }],
    ['cabecera repetida', { authorization: [`Device ${TOKEN}`, `Device ${TOKEN}`] }],
    ['credencial en otra cabecera', { 'x-device-token': TOKEN }],
  ])('%s → 401 sin consultar la base', async (_caso, headers) => {
    const { call, prisma } = setup(terminal());
    await expect(call(headers)).rejects.toThrow(UnauthorizedException);
    expect(prisma.asSystem).not.toHaveBeenCalled();
  });

  it('recorta espacios y a la base solo llega el hash, nunca la credencial', async () => {
    const { call, tx } = setup(terminal());
    await expect(call({ authorization: `Device   ${TOKEN}  ` })).resolves.toBe(true);
    const query = JSON.stringify(tx.terminal.findFirst.mock.calls);
    expect(query).toContain(sha256(TOKEN));
    expect(query).not.toContain(TOKEN);
  });

  it('datáfono desactivado o desvinculado (la búsqueda exige active) → 401', async () => {
    const { call, tx } = setup(null);
    await expect(call({ authorization: `Device ${TOKEN}` })).rejects.toThrow(/sin vincular/);
    expect(tx.terminal.findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { active: true } });
  });
});

describe('DeviceGuard — el local sale del datáfono', () => {
  it('cabeceras o query con otro local no cambian el local del datáfono ni el del contexto', async () => {
    const { call, req, cls } = setup(terminal());
    await call({ authorization: `Device ${TOKEN}`, 'x-tenant-id': OTRO_TENANT, 'x-venue-slug': 'otro' });
    expect(req.posDevice?.tenantId).toBe(TENANT);
    expect(cls.set).toHaveBeenCalledWith('ctx', { traceId: 'tr-1', tenantId: TENANT });
  });

  it('sin contexto CLS se corta (500) en vez de seguir sin filtro por local', async () => {
    const { call } = setup(terminal(), { clsActive: false });
    await expect(call({ authorization: `Device ${TOKEN}` })).rejects.toThrow(InternalServerErrorException);
  });
});

describe('DeviceGuard — "visto por última vez"', () => {
  it('nunca visto o visto hace más de un minuto → se apunta ahora', async () => {
    for (const lastSeen of [null, new Date(NOW.getTime() - 60_001)]) {
      const { call, tx } = setup(terminal({ deviceLastSeenAt: lastSeen }));
      await call({ authorization: `Device ${TOKEN}` });
      expect(tx.terminal.update).toHaveBeenCalledWith({
        where: { id: 'c0ffee00-0000-4000-8000-000000000001' },
        data: { deviceLastSeenAt: NOW },
      });
    }
  });

  it('visto hace un minuto justo o menos → no se escribe', async () => {
    const { call, tx } = setup(terminal({ deviceLastSeenAt: new Date(NOW.getTime() - 60_000) }));
    await call({ authorization: `Device ${TOKEN}` });
    expect(tx.terminal.update).not.toHaveBeenCalled();
  });
});

describe('DeviceGuard — caducidad (POS_DEVICE_TOKEN_MAX_AGE_DAYS)', () => {
  it('justo en el límite aún vale; un milisegundo después, no', async () => {
    vi.stubEnv('POS_DEVICE_TOKEN_MAX_AGE_DAYS', '30');
    const limite = new Date(NOW.getTime() - 30 * DAY_MS);
    await expect(setup(terminal({ deviceTokenIssuedAt: limite })).call({ authorization: `Device ${TOKEN}` })).resolves.toBe(
      true,
    );
    const pasada = new Date(limite.getTime() - 1);
    await expect(setup(terminal({ deviceTokenIssuedAt: pasada })).call({ authorization: `Device ${TOKEN}` })).rejects.toThrow(
      /caducado/,
    );
  });

  it.each(['0', '-5', 'treinta', ' '])('valor %j = no caduca', async (raw) => {
    vi.stubEnv('POS_DEVICE_TOKEN_MAX_AGE_DAYS', raw);
    const antigua = new Date('2021-01-01T00:00:00Z');
    await expect(setup(terminal({ deviceTokenIssuedAt: antigua })).call({ authorization: `Device ${TOKEN}` })).resolves.toBe(
      true,
    );
  });

  it('caducada: no se rota ni se apunta nada', async () => {
    vi.stubEnv('POS_DEVICE_TOKEN_MAX_AGE_DAYS', '7');
    const { call, tx, req } = setup(terminal({ deviceTokenIssuedAt: new Date(NOW.getTime() - 8 * DAY_MS), deviceLastSeenAt: null }));
    await expect(call({ authorization: `Device ${TOKEN}` })).rejects.toThrow(UnauthorizedException);
    expect(tx.terminal.updateMany).not.toHaveBeenCalled();
    expect(tx.terminal.update).not.toHaveBeenCalled();
    expect(req.posDevice).toBeUndefined();
  });
});

describe('@CurrentDevice', () => {
  function factory() {
    class Dummy {
      handler(): void {}
    }
    CurrentDevice()(Dummy.prototype, 'handler', 0);
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Dummy, 'handler') as Record<
      string,
      { factory: (d: unknown, c: ExecutionContext) => PosDevice }
    >;
    const entry = Object.values(meta)[0];
    if (!entry) throw new Error('sin metadatos');
    return entry.factory;
  }
  const ctxWith = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  it('devuelve el datáfono que dejó el guard', () => {
    const device: PosDevice = { terminalId: 't', tenantId: TENANT, label: 'Barra', zone: null, tokenHash: 'h' };
    expect(factory()(undefined, ctxWith({ posDevice: device }))).toBe(device);
  });

  it('sin guard delante (no hay posDevice) → 401', () => {
    expect(() => factory()(undefined, ctxWith({ headers: { authorization: `Device ${TOKEN}` } }))).toThrow(
      UnauthorizedException,
    );
  });
});
