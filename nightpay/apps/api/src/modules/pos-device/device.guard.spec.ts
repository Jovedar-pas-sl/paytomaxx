import { describe, it, expect, vi, afterEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { DeviceGuard, type PosDevice } from './device.guard';
import { sha256 } from './paytef';

const CURRENT = 'credencial-en-uso';
const NEXT = 'credencial-nueva';

function terminal(o: Record<string, unknown> = {}) {
  return {
    id: 'term-1',
    tenantId: 't-1',
    label: 'Barra 1',
    zone: 'BARRA',
    deviceLastSeenAt: new Date(),
    deviceTokenHash: sha256(CURRENT),
    deviceTokenIssuedAt: new Date(),
    devicePairedAt: new Date(),
    ...o,
  };
}

function makeGuard(row: ReturnType<typeof terminal> | null, opts: { promoted?: number; nowCurrent?: boolean } = {}) {
  const tx = {
    terminal: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce(opts.nowCurrent ? { id: 'term-1' } : null),
      updateMany: vi.fn().mockResolvedValue({ count: opts.promoted ?? 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const cls = { isActive: () => true, get: vi.fn(() => ({ traceId: 't' })), set: vi.fn() };
  const guard = new DeviceGuard(prisma as never, cls as never);
  const req: { headers: Record<string, string>; posDevice?: PosDevice } = { headers: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) };
  const call = (token: string | null) => {
    req.headers = token ? { authorization: `Device ${token}` } : {};
    return guard.canActivate(ctx as never);
  };
  return { call, req, tx, cls };
}

afterEach(() => {
  delete process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS;
});

describe('DeviceGuard — credencial del datáfono', () => {
  it('credencial en uso → el datáfono y su local, con el hash para poder rotarla', async () => {
    const { call, req, tx, cls } = makeGuard(terminal());
    await expect(call(CURRENT)).resolves.toBe(true);
    expect(req.posDevice).toEqual({
      terminalId: 'term-1',
      tenantId: 't-1',
      label: 'Barra 1',
      zone: 'BARRA',
      tokenHash: sha256(CURRENT),
    });
    expect(tx.terminal.updateMany).not.toHaveBeenCalled();
    expect(cls.set).toHaveBeenCalledWith('ctx', expect.objectContaining({ tenantId: 't-1' }));
  });

  it('busca por la credencial en uso o la nueva de una rotación', async () => {
    const { call, tx } = makeGuard(terminal());
    await call(CURRENT);
    expect(tx.terminal.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { active: true, OR: [{ deviceTokenHash: sha256(CURRENT) }, { deviceTokenNextHash: sha256(CURRENT) }] },
    });
  });

  it('la primera vez que llega la nueva, pasa a ser la única (la anterior deja de valer)', async () => {
    const { call, tx, req } = makeGuard(terminal());
    await expect(call(NEXT)).resolves.toBe(true);
    expect(tx.terminal.updateMany).toHaveBeenCalledWith({
      where: { id: 'term-1', deviceTokenNextHash: sha256(NEXT) },
      data: expect.objectContaining({ deviceTokenHash: sha256(NEXT), deviceTokenNextHash: null }),
    });
    expect(req.posDevice?.tokenHash).toBe(sha256(NEXT));
  });

  it('dos peticiones con la nueva a la vez: la que llega segunda también vale', async () => {
    const { call } = makeGuard(terminal(), { promoted: 0, nowCurrent: true });
    await expect(call(NEXT)).resolves.toBe(true);
  });

  it('la nueva ya no vale (otra rotación o desvinculado entretanto) → 401', async () => {
    const { call } = makeGuard(terminal(), { promoted: 0, nowCurrent: false });
    await expect(call(NEXT)).rejects.toThrow(UnauthorizedException);
  });

  it('sin credencial o desconocida → 401', async () => {
    await expect(makeGuard(terminal()).call(null)).rejects.toThrow(/sin vincular/);
    await expect(makeGuard(null).call('otra')).rejects.toThrow(/sin vincular/);
  });

  it('con POS_DEVICE_TOKEN_MAX_AGE_DAYS: una credencial más vieja ya no vale', async () => {
    process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS = '30';
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    await expect(makeGuard(terminal({ deviceTokenIssuedAt: old })).call(CURRENT)).rejects.toThrow(/caducado/);
    // Sin fecha de rotación cuenta la de la vinculación.
    await expect(
      makeGuard(terminal({ deviceTokenIssuedAt: null, devicePairedAt: old })).call(CURRENT),
    ).rejects.toThrow(/caducado/);
    await expect(makeGuard(terminal()).call(CURRENT)).resolves.toBe(true);
  });

  it('rotar no rejuvenece la credencial en uso: caduca con su fecha aunque haya una nueva pendiente', async () => {
    process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS = '30';
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const rotatedNow = terminal({ deviceTokenIssuedAt: old, deviceTokenNextIssuedAt: new Date() });
    await expect(makeGuard(rotatedNow).call(CURRENT)).rejects.toThrow(/caducado/);
    // La nueva vale (es reciente) y, al usarla, su fecha pasa a ser la del datáfono.
    const issuedNext = new Date(Date.now() - 60_000);
    const { call, tx } = makeGuard(terminal({ deviceTokenIssuedAt: old, deviceTokenNextIssuedAt: issuedNext }));
    await expect(call(NEXT)).resolves.toBe(true);
    expect(tx.terminal.updateMany).toHaveBeenCalledWith({
      where: { id: 'term-1', deviceTokenNextHash: sha256(NEXT) },
      data: { deviceTokenHash: sha256(NEXT), deviceTokenNextHash: null, deviceTokenIssuedAt: issuedNext, deviceTokenNextIssuedAt: null },
    });
    // Una nueva pedida hace más de 30 días y nunca usada tampoco vale.
    const stale = terminal({ deviceTokenNextIssuedAt: old });
    await expect(makeGuard(stale).call(NEXT)).rejects.toThrow(/caducado/);
  });

  it('sin la variable no caduca nunca (lo de por defecto)', async () => {
    const ancient = new Date('2020-01-01T00:00:00Z');
    await expect(makeGuard(terminal({ deviceTokenIssuedAt: ancient })).call(CURRENT)).resolves.toBe(true);
  });
});
