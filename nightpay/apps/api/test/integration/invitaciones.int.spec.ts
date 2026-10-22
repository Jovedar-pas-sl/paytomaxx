// Integración (Postgres real): «Copa con invitación» — el QR personal de la
// chica, el reparto de la venta (de fábrica, la chica y el local; con parte
// para el camarero si el local se la da) con tarjeta y con el saldo,
// devoluciones y consumos anulados que descuentan a cada uno, y la ficha de la
// chica. Con np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsCreated: { inc: vi.fn() }, paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  {} as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const wallets = new WalletsService(prisma as never, audit as never, { isEnabled: async () => false } as never);
const carta = new CartaService(prisma as never, audit as never);
const cobros = new CobrosService(prisma as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, B: string, owner: string, lola: string, carla: string, dani: string, chicaB: string;
let invita: string, walletId: string;
let n = 0;
const key = () => `inv-${r}-${(n += 1)}`;
const CODE = `I${r.slice(0, 5)}`.toUpperCase();
const body = (o: Record<string, unknown>) => ({ currency: 'EUR', terminalExternalId: `INV-${r}`, ...o }) as never;
const qrOf = (userId: string, tenantId: string) =>
  `https://operator.local/?invita=${signStaffToken({ userId, tenantId }, Date.now(), process.env.JWT_SECRET!).token}`;
const asDani = () => ({ userId: dani, role: 'WAITER' });

async function authorize(paymentId: string, order: string): Promise<void> {
  await sys((tx) => tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } }));
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}
const earningsOf = (where: { paymentId?: string; consumptionId?: string }) =>
  sys((tx) => tx.operatorEarning.findMany({ where, orderBy: { commissionCents: 'desc' } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Local Invita', slug: `inv-a-${r}`, walletGroup: `ginv-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Otro local', slug: `inv-b-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-inv-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    const chica = (email: string, tenantId = A, displayName?: string) =>
      tx.user.create({ data: { tenantId, email, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName } });
    lola = (await chica(`lola-inv-${r}@x.es`, A, 'Lola')).id;
    carla = (await chica(`carla-inv-${r}@x.es`, A, 'Carla')).id;
    chicaB = (await chica(`b-inv-${r}@x.es`, B)).id;
    dani = (await tx.user.create({ data: { tenantId: A, email: `dani-inv-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani' } })).id;
    await tx.terminal.create({ data: { tenantId: A, externalId: `INV-${r}`, label: 'Barra' } });
    walletId = (
      await tx.clientWallet.create({
        data: { tenantId: A, qrToken: `inv-tok-${r}-abcdefgh`, balanceCents: 20_000, status: 'ACTIVE', shortCode: CODE, walletGroup: `ginv-${r}` },
      })
    ).id;
  });
  invita = (
    await inVenue(A, () => carta.create(A, owner, { name: 'Invitar a una copa', priceCents: 2500, category: 'VENUE_BAR', isInvitation: true }))
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('carta: las invitaciones van en Copas', () => {
  it('fuera de Copas no se guarda (API y base)', async () => {
    await expect(
      inVenue(A, () => carta.create(A, owner, { name: 'Mala', priceCents: 2500, category: 'CHICA_SERVICE', isInvitation: true })),
    ).rejects.toThrow(/va en la sección Copas/);
    await expect(
      sys((tx) => tx.serviceItem.create({ data: { tenantId: A, name: 'Mala', priceCents: 1, category: 'VENUE_ROOM', isInvitation: true } })),
    ).rejects.toThrow();
    const list = await inVenue(A, () => carta.listForStaff(A, 'WAITER', dani));
    expect(list.find((i) => i.id === invita)?.isInvitation).toBe(true);
  });
});

describe('invitar con tarjeta: el QR de la chica y el reparto', () => {
  it('sin el QR, con uno caducado, de otro local o de quien cobra → 400 y no se guarda nada', async () => {
    await expect(inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: invita }), asDani()))).rejects.toThrow(
      /Escanea el QR de la chica/,
    );
    const viejo = signStaffToken({ userId: lola, tenantId: A }, Date.now() - 60 * 60_000, process.env.JWT_SECRET!).token;
    await expect(
      inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: invita, invitedStaffToken: viejo }), asDani())),
    ).rejects.toThrow(/ha caducado/);
    await expect(
      inVenue(A, () =>
        payments.create(A, key(), body({ amountCents: 1, serviceItemId: invita, invitedStaffToken: qrOf(chicaB, B) }), asDani()),
      ),
    ).rejects.toThrow(/no vale/);
    // Un QR sin invitación en el cobro, tampoco.
    await expect(
      inVenue(A, () =>
        payments.create(A, key(), body({ amountCents: 1000, revenueCategory: 'VENUE_BAR', invitedStaffToken: qrOf(lola, A) }), asDani()),
      ),
    ).rejects.toThrow(/no lleva ninguna invitación/);
    const made = await sys((tx) => tx.paymentLine.count({ where: { tenantId: A } }));
    expect(made).toBe(0);
  });

  it('de fábrica, Dani invita a Lola: la línea lleva a Lola y su 50 %; el resto, del local (Dani, nada); al pagarse, la ganancia de Lola', async () => {
    const created = await inVenue(A, () =>
      payments.create(A, key(), body({ amountCents: 1, serviceItemId: invita, invitedStaffToken: qrOf(lola, A) }), asDani()),
    );
    expect(created.amountCents).toBe(2500);
    const line = await sys((tx) => tx.paymentLine.findFirst({ where: { paymentId: created.id } }));
    expect(line).toMatchObject({ category: 'VENUE_BAR', beneficiaryOperatorId: lola, beneficiaryCents: 1250, chargerCents: 0 });
    await authorize(created.id, `IV${r}1`);
    const earnings = await earningsOf({ paymentId: created.id });
    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject({ operatorId: lola, commissionCents: 1250, commissionBps: 5000, paymentAmountCents: 2500, paymentLineId: line!.id });
  });

  it('con parte para el camarero (Ajustes): dos ganancias, y una devolución de la mitad descuenta a los dos', async () => {
    await sys((tx) =>
      tx.venue.update({ where: { id: A }, data: { invitationRules: { chica: { kind: 'PERCENT', bps: 4000 }, camarero: { kind: 'FIXED', cents: 300 } } } }),
    );
    const created = await inVenue(A, () =>
      payments.create(
        A,
        key(),
        body({ lines: [{ serviceItemId: invita, qty: 2 }], invitedStaffToken: qrOf(carla, A) }),
        asDani(),
      ),
    );
    await authorize(created.id, `IV${r}2`);
    const earnings = await earningsOf({ paymentId: created.id });
    expect(earnings.map((e) => [e.operatorId, e.commissionCents])).toEqual([
      [carla, 2000],
      [dani, 600],
    ]);
    const refund = await sys((tx) =>
      tx.refund.create({ data: { tenantId: A, paymentId: created.id, amountCents: 2500, requestedBy: owner, status: 'SUCCEEDED' } }),
    );
    await inVenue(undefined, () => payments.applyRefundToEarning(created.id, refund.id, 2500));
    const after = await earningsOf({ paymentId: created.id });
    expect(after.map((e) => [e.operatorId, e.reversedCents])).toEqual([
      [carla, 1000],
      [dani, 300],
    ]);
    // Repetirla no descuenta otra vez.
    await inVenue(undefined, () => payments.applyRefundToEarning(created.id, refund.id, 2500));
    expect((await earningsOf({ paymentId: created.id })).map((e) => e.reversedCents)).toEqual([1000, 300]);
    const reversals = await sys((tx) => tx.earningReversal.findMany({ where: { refundId: refund.id } }));
    expect(reversals).toHaveLength(2);
    // Como las guarda Ajustes (todas las partes): la del camarero, a 0.
    await sys((tx) => tx.venue.update({ where: { id: A }, data: { invitationRules: { chica: { kind: 'PERCENT', bps: 5000 }, camarero: { kind: 'PERCENT', bps: 0 } } } }));
  });
});

describe('invitar con el saldo (NFC, código + PIN o QR)', () => {
  it('la parte de la chica sale del consumo; anular el consumo la descuenta', async () => {
    const qr = await inVenue(A, () =>
      charges.createQrCharge({ userId: dani, role: 'WAITER', tenantId: A }, { serviceItemId: invita, invitedStaffToken: qrOf(lola, A) }),
    );
    await inVenue(undefined, () => charges.payQrCharge(qr.payToken, walletId));
    const consumption = await sys((tx) => tx.walletConsumption.findFirst({ where: { idempotencyKey: `charge-request:${qr.id}` } }));
    const earnings = await earningsOf({ consumptionId: consumption!.id });
    expect(earnings).toEqual([expect.objectContaining({ operatorId: lola, commissionCents: 1250 })]);
    await inVenue(A, () =>
      wallets.reverseConsumption({ tenantId: A, walletId, consumptionId: consumption!.id, actorUserId: owner, actorRole: 'OWNER', reason: 'Se equivocó de copa' }),
    );
    expect((await earningsOf({ consumptionId: consumption!.id }))[0]).toMatchObject({ reversedCents: 1250 });
  });
});

describe('ficha de la chica: sus invitaciones', () => {
  it('cuántas, cuánto y su parte (sin las anuladas); la lista de cobros con la invitada', async () => {
    const summary = await inVenue(A, () => cobros.invitationSummary(A, lola));
    // La de tarjeta (pagada); la del saldo se anuló.
    expect(summary).toEqual({ count: 1, amountCents: 2500, shareCents: 1250 });
    const carlaSummary = await inVenue(A, () => cobros.invitationSummary(A, carla));
    // Devuelta la mitad: sigue contando, con su parte menos lo descontado (20 € − 10 €), como su ganancia.
    expect(carlaSummary).toMatchObject({ count: 2, amountCents: 5000, shareCents: 1000 });
    const page = await inVenue(A, () => cobros.list(A, CobrosQuerySchema.parse({ invitedOperatorId: lola, limit: 50 })));
    expect(page.items.length).toBeGreaterThanOrEqual(2);
    expect(page.items.every((i) => i.invited?.id === lola)).toBe(true);
    expect(page.items[0]).toMatchObject({ person: { id: dani, name: 'Dani' }, invited: { name: 'Lola' } });
    // Las ventas del camarero, a su nombre.
    const danis = await inVenue(A, () => cobros.list(A, CobrosQuerySchema.parse({ operatorId: dani, limit: 50 })));
    expect(danis.items.length).toBeGreaterThanOrEqual(3);
  });
});
