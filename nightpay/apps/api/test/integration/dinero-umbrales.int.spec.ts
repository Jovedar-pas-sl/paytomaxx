// Integración (Postgres real), revisión 2 del dinero: saldos bloqueados que no
// se juntan (M1), 2FA del encargado desde el umbral al anular y al devolver en
// efectivo (M2) y el umbral de «Por aprobar» por cobro, con el cobro
// bloqueado y sumando a todas las personas (M3). Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ApprovalRequestsService } from '../../src/modules/approvals/approval-requests.service';
import { isRefundNeedsApproval } from '../../src/modules/approvals/approval-rules';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { totpStepAt } from '../../src/modules/auth/totp-code';
import { sealTotpSecret } from '../../src/modules/auth/totp-crypto';
import { TotpService } from '../../src/modules/auth/totp.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { newWalletCode } from '../../src/modules/wallets/wallet-rules';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };

// TotpService de verdad: el secreto en users.totpSecret (cifrado) y los
// intentos / códigos usados en un Redis en memoria.
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma as never, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const SECRET = 'JBSWY3DPEHPK3PXP';
/**
 * Un código distinto cada vez (pasos 0 y +1 de la ventana): cada código vale una sola vez.
 * No el −1: si el paso de 30 s cambia entre generarlo y comprobarlo, ya no vale.
 */
let codeOffset = 0;
const nextCode = () => totpCodeAt(SECRET, totpStepAt(Date.now()) + codeOffset++);

const wallets = new WalletsService(prisma as never, audit as never, totp);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp);

const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  refundsCreated: { inc: vi.fn() },
  earningReversalFailed: { inc: vi.fn() },
};
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const bank = { calls: 0 };
const gateways = {
  get: () => ({
    refund: async () => {
      bank.calls += 1;
      await new Promise((r) => setTimeout(r, 250));
      return { status: 'SUCCEEDED', providerRefundId: `RV-${bank.calls}` };
    },
  }),
};
const refunds = new RefundsService(prisma as never, cls as never, gateways as never, payments as never, {} as never, audit as never, metrics as never);
const approvals = new ApprovalRequestsService(prisma as never, audit as never, {} as never, { enabled: () => false } as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let ownerWith2fa: string;
let V: string, owner: string, manager: string, managerNo2fa: string, chica: string, term: string;
let n = 0;

async function newWallet(balanceCents: number, o: { closeRequested?: boolean; blocked?: boolean; status?: 'ACTIVE' | 'DEPLETED' } = {}) {
  n += 1;
  return sys(async (tx) =>
    (
      await tx.clientWallet.create({
        data: {
          tenantId: V,
          balanceCents,
          status: o.status ?? 'ACTIVE',
          qrToken: `du-${r}-${n}`,
          shortCode: newWalletCode(),
          walletGroup: `gdu-${r}`,
          closeRequestedAt: o.closeRequested ? new Date() : null,
          blockedAt: o.blocked ? new Date() : null,
        },
      })
    ).id,
  );
}

async function newConsumption(walletId: string, amountCents: number, tipCents = 0) {
  return sys(async (tx) =>
    (
      await tx.walletConsumption.create({
        data: { tenantId: V, walletId, amountCents, tipCents, providedByUserId: chica, category: 'CHICA_SERVICE' },
      })
    ).id,
  );
}

const walletRow = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));
const reverseAs = (userId: string, walletId: string, consumptionId: string, totpCode?: string) =>
  inVenue(V, () =>
    wallets.reverseConsumption({ tenantId: V, walletId, consumptionId, actorUserId: userId, totpCode, reason: 'error' }),
  );
const managerActor = (userId: string) => ({ userId, role: 'MANAGER' as const, tenantId: V });

/** Cobro ya pagado por una pasarela que devuelve por API. */
async function paidPayment(amountCents: number): Promise<string> {
  n += 1;
  return sys(async (tx) =>
    (
      await tx.payment.create({
        data: {
          tenantId: V,
          terminalId: term,
          idempotencyKey: `du-${r}-${n}`,
          amountCents,
          availableAmountCents: amountCents,
          qrToken: `dup-${r}-${n}`,
          qrExpiresAt: new Date('2030-01-01T00:00:00Z'),
          status: 'AUTHORIZED',
          provider: 'WIPAY',
          providerTxId: `DU${r}${n}`,
          createdByUserId: chica,
          revenueCategory: 'CHICA_SERVICE',
        },
      })
    ).id,
  );
}

/** Un encargado nuevo (sin 2FA): el 2FA por persona (100 € en 24 h) no se prueba aquí. */
async function newManager(): Promise<string> {
  n += 1;
  return sys(async (tx) => (await tx.user.create({ data: { tenantId: V, email: `m${n}-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id);
}

const refundAs = (userId: string, paymentId: string, amountCents: number) =>
  inVenue(V, () => refunds.refund({ paymentId, amountCents, reason: 'queja' }, managerActor(userId)));
const refundRows = (paymentId: string) =>
  sys((tx) => tx.refund.findMany({ where: { paymentId }, select: { amountCents: true, status: true, requestedBy: true } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  const sealed = sealTotpSecret(SECRET, process.env.ENCRYPTION_KEK);
  await sys(async (tx) => {
    // Umbral de «Por aprobar» del local: 100 € (el de la base).
    V = (await tx.venue.create({ data: { name: 'Sala Umbral', slug: `du-${r}`, walletGroup: `gdu-${r}` } })).id;
    const user = async (role: 'OWNER' | 'MANAGER' | 'OPERATOR', tag: string, totpSecret: string | null = null) =>
      (await tx.user.create({ data: { tenantId: V, email: `${tag}-${r}@x.es`, passwordHash: 'x', role, totpSecret } })).id;
    owner = await user('OWNER', 'own');
    ownerWith2fa = await user('OWNER', 'own2', sealed);
    manager = await user('MANAGER', 'man', sealed);
    managerNo2fa = await user('MANAGER', 'man3');
    chica = await user('OPERATOR', 'op');
    term = (await tx.terminal.create({ data: { tenantId: V, externalId: `TDU-${r}`, label: 'Barra' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('M1 — un saldo bloqueado no se junta con otro (Postgres real)', () => {
  it('ni la recarga bloqueada se suma a un saldo libre, ni una recarga se suma a un saldo bloqueado', async () => {
    const blockedSource = await newWallet(8_000, { blocked: true });
    const target = await newWallet(0, { status: 'DEPLETED' });
    await expect(inVenue(undefined, () => charges.mergeInto(blockedSource, target))).rejects.toMatchObject({ status: 409 });
    expect(await walletRow(blockedSource)).toMatchObject({ balanceCents: 8_000, status: 'ACTIVE', mergedIntoId: null });
    expect(await walletRow(target)).toMatchObject({ balanceCents: 0, status: 'DEPLETED' });

    const source = await newWallet(5_000);
    const blockedTarget = await newWallet(1_000, { blocked: true });
    await expect(inVenue(undefined, () => charges.mergeInto(source, blockedTarget))).rejects.toThrow(/bloqueado/);
    expect((await walletRow(source)).balanceCents).toBe(5_000);
    expect((await walletRow(blockedTarget)).balanceCents).toBe(1_000);

    // Sin bloqueo, como siempre.
    await expect(inVenue(undefined, () => charges.mergeInto(source, target))).resolves.toEqual({ balanceCents: 5_000 });
  });
});

/** El saldo entró en efectivo (ayer): en efectivo solo se devuelve lo que entró en efectivo. */
async function cashIn(walletId: string, amountCents: number): Promise<void> {
  await sys((tx) =>
    tx.walletCashTopUp.create({
      data: { tenantId: V, walletId, amountCents, takenByUserId: owner, idempotencyKey: `en-efectivo-${walletId}`, createdAt: new Date(Date.now() - 86_400_000) },
    }),
  );
}

describe('M2 — el encargado desde el umbral pone su 2FA (Postgres real)', () => {
  it('anular un cobro con saldo, por poco que sea: sin código 403 y nada cambia; con su código se anula', async () => {
    const w = await newWallet(0, { status: 'DEPLETED' });
    const c = await newConsumption(w, 1_100, 100);
    await expect(reverseAs(manager, w, c)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect((await walletRow(w)).balanceCents).toBe(0);
    expect((await sys((tx) => tx.walletConsumption.findUniqueOrThrow({ where: { id: c } }))).reversedAt).toBeNull();

    await expect(reverseAs(manager, w, c, nextCode())).resolves.toEqual({ refundedCents: 1_200, newBalanceCents: 1_200 });
  });

  it('anular sin la app de verificación activada no se puede, ni siendo el dueño', async () => {
    const w = await newWallet(1_000);
    const c = await newConsumption(w, 500);
    await expect(reverseAs(managerNo2fa, w, c)).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } });
    await expect(
      inVenue(V, () => wallets.reverseConsumption({ tenantId: V, walletId: w, consumptionId: c, actorUserId: owner, reason: 'error' })),
    ).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } });
    expect((await walletRow(w)).balanceCents).toBe(1_000);
  });

  it('devolver 150 € en efectivo: sin código 403 y el saldo sigue abierto; sin la app activada, TOTP_NOT_ENROLLED; con su código, hecho', async () => {
    const w = await newWallet(15_000, { closeRequested: true });
    await cashIn(w, 15_000);
    await expect(inVenue(V, () => charges.payout(managerActor(manager), w, { method: 'CASH' }))).rejects.toMatchObject({
      response: { code: 'TOTP_REQUIRED' },
    });
    await expect(inVenue(V, () => charges.payout(managerActor(managerNo2fa), w, { method: 'CASH' }))).rejects.toMatchObject({
      response: { code: 'TOTP_NOT_ENROLLED' },
    });
    expect(await walletRow(w)).toMatchObject({ balanceCents: 15_000, status: 'ACTIVE' });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: w } }))).toBe(0);

    await expect(
      inVenue(V, () => charges.payout(managerActor(manager), w, { method: 'CASH', totpCode: nextCode() })),
    ).resolves.toEqual({ refundedCents: 15_000, method: 'CASH' });
    expect(await walletRow(w)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
  });

  it('por debajo del umbral el encargado devuelve en efectivo sin código; el dueño, siempre sin él', async () => {
    const small = await newWallet(9_999, { closeRequested: true });
    await cashIn(small, 9_999);
    await expect(inVenue(V, () => charges.payout(managerActor(managerNo2fa), small, { method: 'CASH' }))).resolves.toMatchObject({
      refundedCents: 9_999,
    });
    const big = await newWallet(50_000);
    await cashIn(big, 50_000);
    await expect(
      inVenue(V, () => charges.payout({ userId: ownerWith2fa, role: 'OWNER', tenantId: V }, big, { totpCode: totpCodeAt(SECRET, totpStepAt(Date.now())), method: 'CASH' })),
    ).resolves.toMatchObject({ refundedCents: 50_000 });
  });
});

describe('M3 — «Por aprobar» por cobro, sumando a todas las personas (Postgres real)', () => {
  it('dos encargados, 60 € y 50 € en el mismo cobro: la segunda ya no sale directa (ni en la ruta ni en la reserva)', async () => {
    const [ana, bea] = [await newManager(), await newManager()];
    const pay = await paidPayment(20_000);
    bank.calls = 0;
    await expect(refundAs(ana, pay, 6_000)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    // La ruta del controlador ya cuenta lo de la otra persona → 202 de entrada.
    expect(await inVenue(V, () => approvals.refundRouteFor(managerActor(bea), 5_000, pay))).toBe('request');
    // Y si llegara a la reserva igualmente, con el cobro bloqueado: REFUND_NEEDS_APPROVAL, sin tocar el banco.
    const err = await refundAs(bea, pay, 5_000).catch((e: unknown) => e);
    expect(isRefundNeedsApproval(err)).toBe(true);
    expect(bank.calls).toBe(1);
    expect(await refundRows(pay)).toEqual([{ amountCents: 6_000, status: 'SUCCEEDED', requestedBy: ana }]);
  });

  it('a la vez, dos de 60 € de dos encargados: sale una; la otra se frena en la reserva (antes pasaban las dos)', async () => {
    const [ana, bea] = [await newManager(), await newManager()];
    const pay = await paidPayment(20_000);
    bank.calls = 0;
    const out = await Promise.allSettled([refundAs(ana, pay, 6_000), refundAs(bea, pay, 6_000)]);
    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(isRefundNeedsApproval((out.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason)).toBe(true);
    expect(bank.calls).toBe(1);
    const rows = await refundRows(pay);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 6_000, status: 'SUCCEEDED' });
  });

  it('por debajo del umbral entre todos, salen directas', async () => {
    const [ana, bea] = [await newManager(), await newManager()];
    const pay = await paidPayment(20_000);
    await expect(refundAs(ana, pay, 5_000)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(refundAs(bea, pay, 4_999)).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });
});
