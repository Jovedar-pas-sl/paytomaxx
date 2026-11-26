// Integración (Postgres real): el resumen de Clientes → Saldos (recargas, consumido y
// consumos por sección). Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';

const cls = new ClsService(new AsyncLocalStorage());

const prisma = new PrismaService(cls as any);
const wallets = new WalletsService(prisma as never, { log: async () => undefined } as never, {} as never);

const r = randomUUID().slice(0, 6);
let A: string;
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

beforeAll(async () => {
  await prisma.onModuleInit();
  await cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    await prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local S', slug: `s-${r}` } })).id;
      const camarero = (await tx.user.create({ data: { tenantId: A, email: `c-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
      const wallet = (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 10_000, qrToken: `wq-${r}` } })).id;
      // 1 entrada (15 €) + 2 gin tonic (2 × 10 €) con saldo: la sección principal es Copas.
      const c = await tx.walletConsumption.create({
        data: { tenantId: A, walletId: wallet, amountCents: 3500, providedByUserId: camarero, category: 'VENUE_BAR', createdAt: minutesAgo(20) },
      });
      const wr = await tx.walletChargeRequest.create({
        data: {
          tenantId: A, walletId: wallet, requestedByUserId: camarero, amountCents: 3500, category: 'VENUE_BAR',
          status: 'ACCEPTED', expiresAt: minutesAgo(-60), consumptionId: c.id,
        },
      });
      await tx.paymentLine.createMany({
        data: [
          { tenantId: A, walletChargeId: wr.id, category: 'VENUE_ENTRY', label: 'Entrada', qty: 1, unitCents: 1500, amountCents: 1500 },
          { tenantId: A, walletChargeId: wr.id, category: 'VENUE_BAR', label: 'Gin tonic', qty: 2, unitCents: 1000, amountCents: 2000 },
        ],
      });
      // Un consumo de antes de las líneas: entero en su sección.
      await tx.walletConsumption.create({
        data: { tenantId: A, walletId: wallet, amountCents: 800, providedByUserId: camarero, category: 'VENUE_FOOD', createdAt: minutesAgo(10) },
      });
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function stats() {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't', tenantId: A });
    return wallets.getAdminStats(A);
  });
}

describe('Clientes → Saldos: consumos por sección (Postgres real)', () => {
  it('un cobro del saldo con varias secciones cuenta cada línea en la suya, como el Z', async () => {
    const s = await stats();
    expect(s.byCategory).toEqual({ VENUE_ENTRY: 1500, VENUE_BAR: 2000, VENUE_FOOD: 800 });
    expect(s.todayConsumptionsCents).toBe(4300);
  });
});
