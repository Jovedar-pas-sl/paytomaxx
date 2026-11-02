// Integración (Postgres real): buscar un cobro por la referencia que se ve en pantalla (C-0022). Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { newWalletCode } from '../../src/modules/wallets/wallet-rules';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const cobros = new CobrosService(prisma);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, B: string, consumptionId: string;

async function payment(tenantId: string, terminalId: string, userId: string, ref: number) {
  return sys((tx) =>
    tx.payment.create({
      data: {
        tenantId,
        terminalId,
        ref,
        idempotencyKey: `bus-${r}-${tenantId}-${ref}`,
        amountCents: 1000,
        availableAmountCents: 1000,
        qrToken: `bus-${r}-${tenantId}-${ref}`,
        qrExpiresAt: new Date('2030-01-01T00:00:00Z'),
        status: 'AUTHORIZED',
        provider: 'REDSYS',
        providerTxId: `RS${r}${ref}`,
        createdByUserId: userId,
        revenueCategory: 'VENUE_BAR',
      },
    }),
  );
}

const search = (tenantId: string, text: string) =>
  inVenue(tenantId, () => cobros.list(tenantId, CobrosQuerySchema.parse({ search: text, limit: 50 })));

beforeAll(async () => {
  await prisma.onModuleInit();
  const venue = async (tag: string) => {
    const { V, U, T } = await sys(async (tx) => {
      const v = await tx.venue.create({ data: { name: `Local ${tag}`, slug: `bus-${tag}-${r}`, walletGroup: `gbus-${tag}-${r}` } });
      const u = await tx.user.create({ data: { tenantId: v.id, email: `own-${tag}-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } });
      const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `TB-${tag}-${r}`, label: 'Barra' } });
      return { V: v.id, U: u.id, T: t.id };
    });
    return { V, U, T };
  };
  const a = await venue('a');
  const b = await venue('b');
  A = a.V;
  B = b.V;
  await payment(A, a.T, a.U, 22);
  await payment(B, b.T, b.U, 22);
  await payment(A, a.T, a.U, 2200);
  // Un cobro pagado con saldo, con su propia referencia.
  await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: A, balanceCents: 500, status: 'ACTIVE', qrToken: `bus-w-${r}`, shortCode: newWalletCode(), walletGroup: `gbus-a-${r}` },
    });
    const c = await tx.walletConsumption.create({
      data: { tenantId: A, walletId: w.id, amountCents: 1200, tipCents: 0, providedByUserId: a.U, category: 'VENUE_BAR' },
    });
    consumptionId = c.id;
    await tx.walletChargeRequest.create({
      data: {
        tenantId: A,
        walletId: w.id,
        requestedByUserId: a.U,
        amountCents: 1200,
        category: 'VENUE_BAR',
        status: 'ACCEPTED',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        decidedAt: new Date(),
        consumptionId: c.id,
        ref: 23,
      },
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('buscar un cobro por su referencia (Postgres real)', () => {
  it('C-0022 encuentra ese cobro del local, y no el 2200 ni el del otro local', async () => {
    const page = await search(A, 'C-0022');
    expect(page.items.map((i) => i.ref)).toEqual(['C-0022']);
    expect((await search(B, 'c0022')).items.map((i) => i.ref)).toEqual(['C-0022']);
  });

  it('también los cobros pagados con saldo, con lo que hace falta para anularlos', async () => {
    const page = await search(A, 'C-0023');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: 'SALDO', ref: 'C-0023', status: 'ACCEPTED', consumptionId });
  });

  it('una referencia que no existe no enseña nada', async () => {
    expect((await search(A, 'C-0099')).items).toEqual([]);
  });

  it('el pedido del banco se sigue encontrando', async () => {
    expect((await search(A, `RS${r}2200`)).items.map((i) => i.ref)).toEqual(['C-2200']);
  });
});
