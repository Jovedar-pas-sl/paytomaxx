// Integración (Postgres real): credencial del datáfono PAX (rotación y caducidad) con np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { DeviceGuard, type PosDevice } from '../../src/modules/pos-device/device.guard';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import { PaytefDeviceSaleProver } from '../../src/modules/pos-device/pos-sale-proof';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const audit = { log: vi.fn(async () => undefined) };
const pos = new PosDeviceService(prisma as never, {} as never, audit as never, cls as never, new PaytefDeviceSaleProver());
const guard = new DeviceGuard(prisma as never, cls as never);
const r = randomUUID().slice(0, 6);
let A: string, term: string;

const run = <T>(fn: () => Promise<T>) =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
async function auth(token: string): Promise<PosDevice> {
  const req: { headers: Record<string, string>; posDevice?: PosDevice } = { headers: { authorization: `Device ${token}` } };
  await run(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never));
  return req.posDevice!;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await run(() =>
    prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local D', slug: `d-${r}` } })).id;
      term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TD-${r}`, label: 'D' } })).id;
    }),
  );
});
afterAll(async () => {
  await prisma.$disconnect();
  delete process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS;
});

describe('credencial del datáfono (Postgres real)', () => {
  it('vincular → rotar: la anterior vale hasta usar la nueva; luego solo la nueva', async () => {
    const { code } = await run(() => pos.createPairingCode(A, term, 'owner'));
    const { token: first } = await run(() => pos.pair(code));
    const dev = await auth(first);
    const { token: second } = await run(() => pos.rotateToken(dev));
    // Se perdió la respuesta: la anterior sigue valiendo y puede volver a rotar.
    await expect(auth(first)).resolves.toMatchObject({ terminalId: term });
    const again = await auth(first);
    const { token: third } = await run(() => pos.rotateToken(again));
    // La segunda ya no está pendiente (la pisó la tercera).
    await expect(auth(second)).rejects.toThrow(/sin vincular/);
    await expect(auth(third)).resolves.toMatchObject({ terminalId: term });
    // Usada la nueva, la anterior ya no vale.
    await expect(auth(first)).rejects.toThrow(/sin vincular/);
    await expect(auth(third)).resolves.toMatchObject({ terminalId: term });
  });

  it('rotar no rejuvenece la credencial en uso; la nueva, al usarla, lleva su propia fecha (seguridad #7)', async () => {
    const { code } = await run(() => pos.createPairingCode(A, term, 'owner'));
    const { token } = await run(() => pos.pair(code));
    const old = new Date(Date.now() - 29 * 86400_000);
    await run(() => prisma.asSystem((tx) => tx.terminal.update({ where: { id: term }, data: { deviceTokenIssuedAt: old } })));
    const { token: next } = await run(async () => pos.rotateToken(await auth(token)));
    const rotated = await run(() =>
      prisma.asSystem((tx) =>
        tx.terminal.findUnique({ where: { id: term }, select: { deviceTokenIssuedAt: true, deviceTokenNextIssuedAt: true } }),
      ),
    );
    expect(rotated!.deviceTokenIssuedAt).toEqual(old);
    expect(Date.now() - rotated!.deviceTokenNextIssuedAt!.getTime()).toBeLessThan(60_000);
    // Dos días después la que está en uso ya ha caducado aunque se rotara; la nueva vale.
    await run(() =>
      prisma.asSystem((tx) =>
        tx.terminal.update({ where: { id: term }, data: { deviceTokenIssuedAt: new Date(Date.now() - 31 * 86400_000) } }),
      ),
    );
    process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS = '30';
    await expect(auth(token)).rejects.toThrow(/caducado/);
    await expect(auth(next)).resolves.toMatchObject({ terminalId: term });
    const promoted = await run(() =>
      prisma.asSystem((tx) =>
        tx.terminal.findUnique({ where: { id: term }, select: { deviceTokenIssuedAt: true, deviceTokenNextIssuedAt: true } }),
      ),
    );
    expect(promoted).toEqual({ deviceTokenIssuedAt: rotated!.deviceTokenNextIssuedAt, deviceTokenNextIssuedAt: null });
    delete process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS;
  });

  it('con caducidad configurada, una credencial vieja no vale; sin ella, sí', async () => {
    const { code } = await run(() => pos.createPairingCode(A, term, 'owner'));
    const { token } = await run(() => pos.pair(code));
    await run(() =>
      prisma.asSystem((tx) =>
        tx.terminal.update({ where: { id: term }, data: { deviceTokenIssuedAt: new Date(Date.now() - 40 * 86400_000) } }),
      ),
    );
    await expect(auth(token)).resolves.toMatchObject({ terminalId: term });
    process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS = '30';
    await expect(auth(token)).rejects.toThrow(/caducado/);
  });
});
