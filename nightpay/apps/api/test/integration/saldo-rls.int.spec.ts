// Integración (Postgres real): saldo entre locales del grupo con RLS forzado. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const audit = { log: async () => undefined };
// 2FA del encargado (desde el umbral, en efectivo): aquí se da por buena; se prueba en dinero-umbrales.
const totpOk = { isEnabled: async () => true, assertForUser: async () => undefined };
const svc = new WalletChargesService(prisma as never, audit as never, { get: () => null } as never, totpOk as never);
const incidents = new IncidentsService(prisma as never, audit as never);

function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
}
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
}

const r = randomUUID().slice(0, 8);
let A: string, B: string, C: string, chica: string, managerB: string, walletId: string, requestId: string, payToken: string;
const CODE = 'K7Q4M2';
const TOKEN = `tok-${r}-abcdefghijkl`;

beforeAll(async () => {
  await prisma.onModuleInit();
  await asPublic(() =>
    prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local A', slug: `a-${r}`, walletGroup: 'principal' } })).id;
      B = (await tx.venue.create({ data: { name: 'Local B', slug: `b-${r}`, walletGroup: 'principal' } })).id;
      C = (await tx.venue.create({ data: { name: 'Local C', slug: `c-${r}`, walletGroup: 'otro' } })).id;
      chica = (
        await tx.user.create({
          data: { tenantId: B, email: `chica-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000 },
        })
      ).id;
      managerB = (
        await tx.user.create({ data: { tenantId: B, email: `enc-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })
      ).id;
      walletId = (
        await tx.clientWallet.create({
          data: {
            tenantId: A,
            qrToken: TOKEN,
            balanceCents: 30_000,
            status: 'ACTIVE',
            shortCode: CODE,
            walletGroup: 'principal',
            identifier: 'Mesa 3',
          },
        })
      ).id;
      // Lo cargó en efectivo en la recepción de A (en efectivo solo se devuelve lo que entró en efectivo).
      await tx.walletCashTopUp.create({
        data: { tenantId: A, walletId, amountCents: 30_000, takenByUserId: managerB, idempotencyKey: `rls-${r}`, createdAt: new Date(Date.now() - 86_400_000) },
      });
    }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('saldo contra Postgres real (RLS forzado, rol dueño no superusuario)', () => {
  it('sin bypass, client_wallets no se ve (por eso aceptar necesita acrossVenues)', async () => {
    const rows = await asPublic(() =>
      prisma.$transaction((tx) => tx.$queryRaw<unknown[]>`SELECT id FROM client_wallets WHERE id = ${walletId}::uuid`),
    );
    expect(rows).toHaveLength(0);
  });

  it('la chica del local B encuentra el saldo cargado en A; el local C no', async () => {
    const found = await asTenant(B, () => svc.lookup(B, 'k7q-4m2'));
    expect(found).toMatchObject({ walletId, balanceCents: 30_000, isHomeVenue: false, homeVenueName: 'Local A' });
    await expect(asTenant(C, () => svc.lookup(C, CODE))).rejects.toThrow(/No hay ningún saldo/);
  });

  it('la chica hace un cobro con QR (aún sin saldo); la página del cliente no tiene cobros que aceptar', async () => {
    const actor = { userId: chica, role: 'OPERATOR' as const, tenantId: B };
    const req = await asTenant(B, () => svc.createQrCharge(actor, { amountCents: 10_000 }));
    expect(req.status).toBe('PENDING');
    requestId = req.id;
    payToken = req.payToken;
    const state = await asPublic(() => svc.clientState(TOKEN));
    expect(state).not.toHaveProperty('pending');
  });

  it('el cliente paga el QR (Face ID): se descuenta, consumo en B y la parte de la chica', async () => {
    const paid = await asPublic(() => svc.payQrCharge(payToken, walletId));
    expect(paid.balanceCents).toBe(20_000);
    const state = await asPublic(() => svc.clientState(TOKEN));
    expect(state.balanceCents).toBe(20_000);
    const [consumption, earning] = await asPublic(() =>
      prisma.asSystem(async (tx) => [
        await tx.walletConsumption.findFirst({ where: { walletId } }),
        await tx.operatorEarning.findFirst({ where: { operatorId: chica } }),
      ]),
    );
    expect(consumption).toMatchObject({ tenantId: B, amountCents: 10_000, providedByUserId: chica });
    expect(earning).toMatchObject({ tenantId: B, commissionBps: 9000, commissionCents: 9000 });
    const view = await asTenant(B, () => svc.getRequest({ userId: chica, role: 'OPERATOR', tenantId: B }, requestId));
    expect(view).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 20_000 });
    // Pagar dos veces no cobra dos veces.
    await expect(asPublic(() => svc.payQrCharge(payToken, walletId))).rejects.toThrow(/ya no está pendiente/);
  });

  it('«Me voy» ya no pide nada (409); una devolución pedida antes sale en Incidencias del local de la recarga', async () => {
    await expect(asPublic(() => svc.requestClose(TOKEN))).rejects.toMatchObject({ status: 409, response: { code: 'SALDO_NO_SE_DEVUELVE' } });
    const before = await asPublic(() => prisma.asSystem((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId } })));
    expect(before.closeRequestedAt).toBeNull();
    // Una pedida antes de la nueva regla (el «Me voy» de antes).
    await asPublic(() => prisma.asSystem((tx) => tx.clientWallet.update({ where: { id: walletId }, data: { closeRequestedAt: new Date() } })));
    const items = await asTenant(A, () => incidents.list(A, new Date()));
    expect(items.map((i) => i.kind)).toContain('wallet_close_requested');
  });

  it('el encargado de B lo devuelve en efectivo: wallet cerrada y apuntado en B', async () => {
    const out = await asTenant(B, () =>
      svc.payout({ userId: managerB, role: 'MANAGER', tenantId: B }, walletId, { method: 'CASH', totpCode: '123456' }),
    );
    expect(out).toEqual({ refundedCents: 20_000, method: 'CASH' });
    const [w, payout] = await asPublic(() =>
      prisma.asSystem(async (tx) => [
        await tx.clientWallet.findUnique({ where: { id: walletId } }),
        await tx.walletPayout.findFirst({ where: { walletId } }),
      ]),
    );
    expect(w).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(payout).toMatchObject({ tenantId: B, amountCents: 20_000, method: 'CASH', paidByUserId: managerB });
    const state = await asPublic(() => svc.clientState(TOKEN));
    expect(state.movements.map((m) => m.kind)).toEqual(expect.arrayContaining(['consumption', 'payout']));
  });
});
