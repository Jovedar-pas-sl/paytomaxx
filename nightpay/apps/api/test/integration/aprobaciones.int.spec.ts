// Integración (Postgres real): «Por aprobar». El encargado pide pagos a las chicas y devoluciones desde el
// umbral del local; el dueño las aprueba con su 2FA (de verdad, guardada en la base) y quien pide nunca
// aprueba. Con el rol sin superusuario (FORCE RLS) y el local en el contexto, como tras AuthGuard. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { CreatePayoutDto, JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { payoutRequestHash } from '../../src/modules/operators/payout-idempotency';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { RefundsController } from '../../src/modules/refunds/refunds.controller';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { PeanpeAdapter } from '../../src/modules/gateways/peanpe.adapter';
import { ApprovalRequestsService, type ApprovalActor } from '../../src/modules/approvals/approval-requests.service';
import { ApprovalsService } from '../../src/modules/approvals/approvals.service';
import { assertNoPendingPayout } from '../../src/modules/approvals/approval-store';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const auditLog: Array<{ action: string; targetId?: string; payload?: Record<string, unknown> | null }> = [];
const audit = { log: async (e: (typeof auditLog)[number]) => void auditLog.push(e) };
const settings: Record<string, string | number> = {
  OPERATOR_BASE_URL: 'https://chicas.example.com',
  PAYOUT_HOLD_DAYS: 7,
  GATEWAY_TIMEOUT_MS: 5000,
  PEANPE_API_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  PEANPE_ACCOUNT_ID: '91816',
  PEANPE_API_BASE_URL: 'http://peanpe.invalid',
  PEANPE_AMOUNT_FORMAT_VERIFIED: 'cents',
};
const config = {
  get: (k: string) => settings[k],
  getOrThrow: (k: string) => {
    if (settings[k] === undefined) throw new Error(`sin ${k}`);
    return settings[k];
  },
};
const fx = { getEurToUsdtRateInfo: async () => ({ rate: 1.07, degraded: false }) };
const gatewayMetrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };

// La pasarela de mentira: hace la devolución, salvo que la prueba diga que la rechace.
let gatewaySays: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
let gatewayCalls = 0;
const gateways = {
  get: () => ({
    refund: async () => {
      gatewayCalls += 1;
      return { status: gatewaySays, providerRefundId: `GW-${gatewayCalls}` };
    },
  }),
};

const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));

const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, fx as never, {} as never);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  new PeanpeAdapter(config as never, gatewayMetrics as never, prisma),
  {} as never,
);
const refunds = new RefundsService(
  prisma,
  cls as never,
  gateways as never,
  payments,
  totp,
  audit as never,
  { refundsCreated: { inc: vi.fn() }, earningReversalFailed: { inc: vi.fn() } } as never,
);
const notifier = { enabled: () => false, requested: vi.fn() };
const requests = new ApprovalRequestsService(prisma, audit as never, config as never, notifier as never);
const approvals = new ApprovalsService(prisma, requests, operators, refunds, totp, audit as never);
const refundsController = new RefundsController(refunds, requests);
const incidents = new IncidentsService(prisma, audit as never);

/** Una petición del panel de ese local (como tras AuthGuard). */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-ap-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-ap' });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => asPublic(() => prisma.asSystem(fn)) as Promise<T>;

/** Código HTTP y cuerpo de un error de Nest. */
async function failure(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const body = err.getResponse();
  return { status: err.getStatus(), body: typeof body === 'string' ? { message: body } : (body as Record<string, unknown>) };
}

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60 * 1000;
let seq = 0;
const uniq = (p: string) => `${p}-${r}-${++seq}`;

let V: string;
let B: string;
let term: string;
const secrets = new Map<string, string>();

async function newUser(tenantId: string, role: 'OWNER' | 'MANAGER', name: string, withTotp: boolean): Promise<string> {
  const secret = withTotp ? totp.newSecret() : null;
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId,
          email: `${uniq(role.toLowerCase())}@x.es`,
          passwordHash: 'x',
          role,
          displayName: name,
          totpSecret: secret ? totp.sealSecret(secret) : null,
        },
      })
    ).id,
  );
  if (secret) secrets.set(id, secret);
  return id;
}
/** Un dueño nuevo con su 2FA (cada aprobación con el suyo: un código vale una vez). */
const newOwner = (tenantId = V) => newUser(tenantId, 'OWNER', 'Dueño', true);
const newManager = (name: string) => newUser(V, 'MANAGER', name, false);
const codeOf = (ownerId: string) => totpCodeAt(secrets.get(ownerId)!);
const owner = (userId: string, tenantId = V): ApprovalActor => ({ userId, role: 'OWNER', tenantId });
const managerOf = (userId: string): ApprovalActor => ({ userId, role: 'MANAGER', tenantId: V });
const jwtOf = (a: ApprovalActor) => ({ sub: a.userId, role: a.role, tenantId: a.tenantId }) as unknown as JwtPayload;

/** Un cobro pagado por la pasarela (Paytef), de una chica con su comisión del 90 %. */
async function newPayment(chica: string, amountCents: number, ago = 2 * HOUR): Promise<string> {
  return sys<string>(async (tx) => {
    const at = new Date(Date.now() - ago);
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents, availableAmountCents: amountCents,
        createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', authorizedAt: at, createdAt: at, cardLast4: '4242', cardBrand: 'VISA',
      } as never,
    });
    const commission = Math.round(amountCents * 0.9);
    await tx.operatorEarning.create({
      data: { tenantId: V, operatorId: chica, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000, commissionCents: commission, createdAt: at },
    });
    return p.id;
  });
}

/** Una chica con su cuenta USDT y cobros ya pagables (el local paga al cierre de la noche). */
async function newChica(name: string, payments: number[] = []): Promise<string> {
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId: V, email: `${uniq('chica')}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: name,
          payoutMethod: 'USDT_TRC20', payoutAddress: `TQ${randomUUID().replace(/-/g, '').slice(0, 32)}`,
        } as never,
      })
    ).id,
  );
  for (const cents of payments) await newPayment(id, cents);
  return id;
}

const balanceOf = (chica: string) => asStaff(V, () => operators.getBalance(chica, V));
const payoutsOf = (chica: string) => sys<Array<{ id: string; totalCents: number }>>((tx) =>
  tx.operatorPayout.findMany({ where: { operatorId: chica }, select: { id: true, totalCents: true } }),
);
const rowOf = (id: string) => sys<{ status: string; resultRef: string | null; failureReason: string | null; decidedById: string | null }>((tx) =>
  tx.approvalRequest.findUniqueOrThrow({ where: { id } }),
);
const availableOf = (paymentId: string) =>
  sys<number>(async (tx) => (await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).availableAmountCents);
const pay = (a: ApprovalActor, chica: string) =>
  asStaff(V, () => requests.requestPayout(a, chica, { externalRail: 'USDT_TRC20', notes: 'cierre de la noche' }));
const askRefund = (a: ApprovalActor, paymentId: string, amountCents: number) =>
  asStaff(V, () => requests.requestRefund(a, { paymentId, amountCents, reason: 'el cliente se quejó' }));
const approve = (ownerId: string, id: string, tenantId = V) =>
  asStaff(tenantId, () => approvals.approve(owner(ownerId, tenantId), id, codeOf(ownerId)));
/** El pago directo del dueño, como el endpoint (con la comprobación de peticiones pendientes). */
const payDirect = (ownerId: string, chica: string) =>
  asStaff(V, () => operators.createPayout(V, chica, ownerId, undefined, { externalRail: 'USDT_TRC20', inTransaction: (tx) => assertNoPendingPayout(tx, V, chica) }));

let manager: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, B, term } = await sys<{ V: string; B: string; term: string }>(async (tx) => {
    // Se paga a las chicas al cierre de la noche (0 días de espera); pagos con aprobación (por defecto) y umbral 100 €.
    const v = await tx.venue.create({ data: { name: `Aprob ${r}`, slug: `aprob-${r}`, payoutHoldDays: 0 } });
    const b = await tx.venue.create({ data: { name: `Aprob B ${r}`, slug: `aprob-b-${r}`, payoutHoldDays: 0 } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `AP-${r}`, label: 'Barra' } });
    return { V: v.id, B: b.id, term: t.id };
  }));
  manager = await newManager('Ana');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pagos a las chicas', () => {
  it('el encargado pide (no paga), el dueño aprueba con su 2FA: el pago existe y el saldo de la chica baja', async () => {
    const chica = await newChica('Lola', [10_000, 5_000]);
    expect(await balanceOf(chica)).toMatchObject({ availableCents: 13_500 });
    expect(await asStaff(V, () => requests.payoutRouteFor(managerOf(manager)))).toEqual({ kind: 'request' });

    const asked = await pay(managerOf(manager), chica);
    expect(asked).toEqual({
      approvalRequestId: expect.any(String),
      status: 'PENDING',
      kind: 'PAYOUT',
      amountCents: 13_500,
      message: 'Pedido al dueño. Te avisamos cuando lo apruebe.',
    });
    // Pedirlo no paga nada.
    expect(await payoutsOf(chica)).toEqual([]);
    expect(await balanceOf(chica)).toMatchObject({ availableCents: 13_500 });

    const boss = await newOwner();
    const pending = await asStaff(V, () => requests.list(owner(boss), { status: 'PENDING', limit: 50 }));
    const card = pending.items.find((i) => i.id === asked.approvalRequestId);
    expect(card).toMatchObject({
      kind: 'PAYOUT',
      status: 'PENDING',
      amountCents: 13_500,
      canDecide: true,
      requestedBy: { name: 'Ana', role: 'MANAGER' },
      payout: { operatorName: 'Lola', method: 'USDT_TRC20', accountMasked: expect.stringMatching(/^T…\w{4}$/), earningCount: 2 },
    });
    const mine = await asStaff(V, () => requests.list(managerOf(manager), { limit: 50 }));
    expect(mine.items.find((i) => i.id === asked.approvalRequestId)).toMatchObject({ status: 'PENDING', canDecide: false });

    const done = await approve(boss, asked.approvalRequestId);
    expect(done).toMatchObject({ status: 'APPROVED', decidedBy: { id: boss }, resultRef: expect.any(String) });
    const [payout] = await payoutsOf(chica);
    expect(payout).toEqual({ id: done.resultRef, totalCents: 13_500 });
    expect(await balanceOf(chica)).toMatchObject({ availableCents: 0, paidCents: 13_500 });
    expect(auditLog.filter((e) => e.targetId === asked.approvalRequestId).map((e) => e.action)).toEqual([
      'approval.requested',
      'approval.approved',
    ]);
    expect(auditLog.find((e) => e.action === 'operator.payout.created' && e.payload?.payoutId === done.resultRef)?.payload)
      .toMatchObject({ approvalRequestId: asked.approvalRequestId });
  });

  it('quien pide no aprueba: ni el encargado, ni siendo dueño; y la base tampoco lo deja', async () => {
    const chica = await newChica('Nora', [5_000]);
    const asked = await pay(managerOf(manager), chica);
    expect(await failure(asStaff(V, () => approvals.approve(managerOf(manager), asked.approvalRequestId, '123456')))).toMatchObject({
      status: 403,
      body: { code: 'APPROVAL_FORBIDDEN' },
    });
    // La encargada a la que hacen dueña (o un super-admin): lo suyo, tampoco.
    const promoted = { userId: manager, role: 'OWNER' as const, tenantId: V };
    expect(await failure(asStaff(V, () => approvals.approve(promoted, asked.approvalRequestId, '123456')))).toMatchObject({
      status: 403,
      body: { code: 'APPROVAL_OWN_REQUEST' },
    });
    await expect(
      sys((tx) =>
        tx.approvalRequest.update({
          where: { id: asked.approvalRequestId },
          data: { status: 'APPROVED', decidedById: manager, decidedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/approval_requests_decider_not_requester/);
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'PENDING' });
    expect(await payoutsOf(chica)).toEqual([]);
  });

  it('aprobar dos veces no paga dos veces: seguidas (mismo dueño) y a la vez (dos dueños)', async () => {
    const chica = await newChica('Vera', [8_000]);
    const asked = await pay(managerOf(manager), chica);
    const boss = await newOwner();
    const first = await approve(boss, asked.approvalRequestId);
    const again = await asStaff(V, () => approvals.approve(owner(boss), asked.approvalRequestId, '000000'));
    expect(again).toMatchObject({ status: 'APPROVED', resultRef: first.resultRef });
    expect(await payoutsOf(chica)).toHaveLength(1);

    const other = await newChica('Iris', [6_000]);
    const twice = await pay(managerOf(manager), other);
    const [a, b] = [await newOwner(), await newOwner()];
    const both = await Promise.all([approve(a, twice.approvalRequestId), approve(b, twice.approvalRequestId)]);
    expect(both.map((v) => v.status)).toEqual(['APPROVED', 'APPROVED']);
    expect(both[0].resultRef).toBe(both[1].resultRef);
    expect(await payoutsOf(other)).toEqual([{ id: both[0].resultRef, totalCents: 5_400 }]);
  });

  it('dos peticiones a la vez para la misma chica: una sola; y mientras, nadie le paga por otro lado', async () => {
    const chica = await newChica('Sara', [7_000]);
    const bea = await newManager('Bea');
    const results = await Promise.allSettled([pay(managerOf(manager), chica), pay(managerOf(bea), chica)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((x): x is PromiseRejectedResult => x.status === 'rejected')!;
    expect(lost.reason).toBeInstanceOf(HttpException);
    expect((lost.reason as HttpException).getResponse()).toMatchObject({ code: 'APPROVAL_ALREADY_PENDING' });

    // El dueño que va a pagarle directo: sus comisiones están pedidas.
    const boss = await newOwner();
    expect(await failure(payDirect(boss, chica))).toMatchObject({ status: 409, body: { code: 'APPROVAL_ALREADY_PENDING' } });
    expect(await payoutsOf(chica)).toEqual([]);
  });

  it('rechazar: con el motivo, el encargado lo ve, ya no se aprueba y libera la chica', async () => {
    const chica = await newChica('Rita', [4_000]);
    const asked = await pay(managerOf(manager), chica);
    const boss = await newOwner();
    const rejected = await asStaff(V, () => requests.reject(owner(boss), asked.approvalRequestId, 'Ya se le pagó en efectivo'));
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Ya se le pagó en efectivo', decidedBy: { id: boss } });
    // Rechazar otra vez no cambia nada; aprobarla ya no se puede.
    expect(await asStaff(V, () => requests.reject(owner(boss), asked.approvalRequestId, 'otra vez'))).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'Ya se le pagó en efectivo',
    });
    expect(await failure(approve(await newOwner(), asked.approvalRequestId))).toMatchObject({
      status: 409,
      body: { code: 'APPROVAL_NOT_PENDING' },
    });
    const mine = await asStaff(V, () => requests.list(managerOf(manager), { status: 'REJECTED', limit: 50 }));
    expect(mine.items.find((i) => i.id === asked.approvalRequestId)).toMatchObject({ decisionNote: 'Ya se le pagó en efectivo' });
    // Ya no reserva: se le puede pagar directo.
    await expect(payDirect(boss, chica)).resolves.toMatchObject({ totalCents: 3_600 });
  });

  it('a las 24 h caduca: deja de reservar, ya no se aprueba y el repaso la marca', async () => {
    const chica = await newChica('Eva', [3_000]);
    const asked = await pay(managerOf(manager), chica);
    await sys((tx) =>
      tx.approvalRequest.update({ where: { id: asked.approvalRequestId }, data: { requestedAt: new Date(Date.now() - 25 * HOUR) } }),
    );
    expect(await failure(approve(await newOwner(), asked.approvalRequestId))).toMatchObject({
      status: 409,
      body: { code: 'APPROVAL_EXPIRED' },
    });
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'EXPIRED' });
    // Una pedida hace 25 h que nadie ha mirado: el repaso la caduca.
    const chica2 = await newChica('Ona', [3_000]);
    const stale = await pay(managerOf(manager), chica2);
    await sys((tx) =>
      tx.approvalRequest.update({ where: { id: stale.approvalRequestId }, data: { requestedAt: new Date(Date.now() - 25 * HOUR) } }),
    );
    // Aunque siga PENDING en la base, ya no reserva: el dueño le paga directo.
    await expect(payDirect(await newOwner(), chica2)).resolves.toMatchObject({ totalCents: 2_700 });
    expect(await asPublic(() => requests.expireStale())).toBeGreaterThanOrEqual(1);
    expect(await rowOf(stale.approvalRequestId)).toMatchObject({ status: 'EXPIRED' });
    expect(auditLog.some((e) => e.action === 'approval.expired' && e.targetId === stale.approvalRequestId)).toBe(true);
  });

  it('si la cuenta de la chica cambió desde que se pidió: no se paga y queda FAILED con la razón', async () => {
    const chica = await newChica('Gala', [5_000]);
    const asked = await pay(managerOf(manager), chica);
    await sys((tx) => tx.user.update({ where: { id: chica }, data: { payoutAddress: `TQ${'9'.repeat(32)}` } as never }));
    const res = await failure(approve(await newOwner(), asked.approvalRequestId));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_CHANGED', message: expect.stringMatching(/^No se ha pagado nada/) } });
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/cuenta de cobro/) });
    expect(await payoutsOf(chica)).toEqual([]);
  });
});

describe('pagos a las chicas «Por aprobar»: la cifra que vio el encargado y la Idempotency-Key', () => {
  const ask = (a: ApprovalActor, chica: string, dto: CreatePayoutDto, key?: string) =>
    asStaff(V, () =>
      requests.requestPayout(a, chica, dto, key ? { key, hash: payoutRequestHash(a.userId, chica, dto) } : undefined),
    );
  const requestsOf = (chica: string) =>
    sys<Array<{ id: string; status: string; amountCents: number }>>((tx) =>
      tx.approvalRequest.findMany({ where: { targetId: chica }, select: { id: true, status: true, amountCents: true } }),
    );

  it('si lo pagable ya no es lo que vio: 409 PAYOUT_CHANGED y no se pide nada', async () => {
    const chica = await newChica('Cloe', [10_000]);
    const res = await failure(ask(managerOf(manager), chica, { externalRail: 'USDT_TRC20', expectedTotalCents: 8_000 }));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_CHANGED', message: expect.stringMatching(/ahora son 90,00\u00a0€, no 80,00\u00a0€/) } });
    expect(await requestsOf(chica)).toEqual([]);
  });

  it('repetir la misma petición (sin respuesta, doble clic, a la vez) da la misma solicitud; otra con la clave → 409', async () => {
    const chica = await newChica('Dafne', [10_000]);
    const dto: CreatePayoutDto = { externalRail: 'USDT_TRC20', expectedTotalCents: 9_000, notes: 'cierre' };
    const key = `pedir-${randomUUID()}`;
    const [a, b] = await Promise.all([ask(managerOf(manager), chica, dto, key), ask(managerOf(manager), chica, dto, key)]);
    expect(a.approvalRequestId).toBe(b.approvalRequestId);
    const again = await ask(managerOf(manager), chica, dto, key);
    expect(again).toEqual(a);
    expect(await requestsOf(chica)).toEqual([{ id: a.approvalRequestId, status: 'PENDING', amountCents: 9_000 }]);
    expect(auditLog.filter((e) => e.action === 'approval.requested' && e.targetId === a.approvalRequestId)).toHaveLength(1);

    // La misma clave con otra petición, otra chica u otra persona: 409 y nada nuevo.
    expect(await failure(ask(managerOf(manager), chica, { ...dto, notes: 'otra' }, key))).toMatchObject({
      status: 409,
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    const other = await newChica('Elsa', [5_000]);
    expect(await failure(ask(managerOf(manager), other, { externalRail: 'USDT_TRC20' }, key))).toMatchObject({
      status: 409,
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(await requestsOf(other)).toEqual([]);
    // Ya aprobada, repetirla devuelve esa misma solicitud: no se pide (ni se paga) otra vez.
    await approve(await newOwner(), a.approvalRequestId);
    await expect(ask(managerOf(manager), chica, dto, key)).resolves.toMatchObject({ approvalRequestId: a.approvalRequestId });
    expect(await payoutsOf(chica)).toEqual([{ id: expect.any(String), totalCents: 9_000 }]);
  });

  it('si la cifra cambia entre pedirlo y aprobarlo (una devolución): 409 PAYOUT_CHANGED, FAILED y no se paga otra cifra', async () => {
    const chica = await newChica('Fiona', [10_000, 5_000]);
    const asked = await ask(managerOf(manager), chica, { externalRail: 'USDT_TRC20', expectedTotalCents: 13_500 });
    expect(asked.amountCents).toBe(13_500);
    // Entre medias, una devolución le quita 20 € de comisión a una de las que se pidieron.
    await sys((tx) =>
      tx.$executeRaw`UPDATE operator_earnings SET "reversedCents" = 2000
                      WHERE id = (SELECT id FROM operator_earnings WHERE "operatorId" = ${chica}::uuid ORDER BY id LIMIT 1)`,
    );
    const res = await failure(approve(await newOwner(), asked.approvalRequestId));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_CHANGED', message: expect.stringMatching(/^No se ha pagado nada/) } });
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/ha cambiado/) });
    expect(await payoutsOf(chica)).toEqual([]);
    // Ya no reserva: se pide otra vez con la cifra de ahora.
    await expect(ask(managerOf(manager), chica, { externalRail: 'USDT_TRC20', expectedTotalCents: 11_500 })).resolves.toMatchObject({
      amountCents: 11_500,
    });
  });
});

describe('«Marcar pagado» con la misma Idempotency-Key a la vez (FORCE RLS: Prisma no dice qué índice chocó)', () => {
  const dto: CreatePayoutDto = { externalRail: 'USDT_TRC20', expectedTotalCents: 9_000, notes: 'cierre' };
  const markPaid = (ownerId: string, chica: string, key: string, afterCreate?: () => Promise<void>) =>
    asStaff(V, () =>
      operators.createPayout(V, chica, ownerId, dto.notes, {
        externalRail: dto.externalRail,
        expectedTotalCents: dto.expectedTotalCents,
        idempotency: { key, hash: payoutRequestHash(ownerId, chica, dto) },
        inTransaction: (tx) => assertNoPendingPayout(tx, V, chica),
        ...(afterCreate ? { afterCreate: () => afterCreate() } : {}),
      }),
    );

  it('dos a la vez para la misma chica: un solo pago y las dos respuestas son ese', async () => {
    const boss = await newOwner();
    const chica = await newChica('Gala', [10_000]);
    const key = `pagar-${randomUUID()}`;
    const [a, b] = await Promise.all([markPaid(boss, chica, key), markPaid(boss, chica, key)]);
    expect(a).toEqual(b);
    expect(await payoutsOf(chica)).toEqual([{ id: a.id, totalCents: 9_000 }]);
    expect(auditLog.filter((e) => e.action === 'operator.payout.created' && e.payload?.payoutId === a.id)).toHaveLength(1);
  });

  it('la misma clave a la vez para dos chicas: una se paga y la otra choca al apuntarlo → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const boss = await newOwner();
    const [hana, ines] = [await newChica('Hana', [10_000]), await newChica('Ines', [10_000])];
    const key = `pagar-${randomUUID()}`;
    // El pago de Hana se queda apuntado sin confirmar hasta que el de Inés llega a apuntarse con la misma clave:
    // Inés no la ve al empezar (aún no está confirmada) y su INSERT espera al índice único y choca.
    let reached!: () => void;
    const hanaInserted = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = markPaid(boss, hana, key, async () => {
      reached();
      await gate;
    });
    await hanaInserted;
    const second = failure(markPaid(boss, ines, key));
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await expect(first).resolves.toMatchObject({ totalCents: 9_000 });
    expect(await second).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect((await payoutsOf(hana)).length).toBe(1);
    expect(await payoutsOf(ines)).toEqual([]);
    expect(await balanceOf(ines)).toMatchObject({ availableCents: 9_000 });
  });
});

describe('devoluciones', () => {
  it('misma intención concurrente conserva aprobación y resultado al aprobarla sin devolver dos veces', async () => {
    const chica = await newChica('Retry');
    const payment = await newPayment(chica, 15_000);
    const manager = await newManager('Retry Manager');
    const body = { amountCents: 15_000, reason: 'Cliente se va', idempotencyKey: randomUUID() };
    const call = () => asStaff(V, () => refundsController.create(payment, body, jwtOf(managerOf(manager)), { status: vi.fn() } as never));
    const before = gatewayCalls;
    const [a, b] = await Promise.all([call(), call()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'PENDING' });
    const approvalId = (a as { approvalRequestId: string }).approvalRequestId;
    await approve(await newOwner(), approvalId);
    const result = await call();
    expect(result).toMatchObject({ status: 'SUCCEEDED', amountCents: 15_000 });
    await expect(call()).resolves.toEqual(result);
    expect(gatewayCalls).toBe(before + 1);
    expect(await availableOf(payment)).toBe(0);
  });
  it('desde el umbral (100 €) el encargado la pide (202); por debajo la hace él; el dueño, directa', async () => {
    const chica = await newChica('Paz');
    const payment = await newPayment(chica, 30_000);
    const ines = await newManager('Inés');
    const reply = { status: vi.fn() };
    const below = await asStaff(V, () =>
      refundsController.create(payment, { amountCents: 9_999, reason: 'copa mal' }, jwtOf(managerOf(ines)), reply as never),
    );
    expect(below).toMatchObject({ status: 'SUCCEEDED', amountCents: 9_999 });
    expect(reply.status).not.toHaveBeenCalled();

    const asked = await asStaff(V, () =>
      refundsController.create(payment, { amountCents: 10_000, reason: 'servicio' }, jwtOf(managerOf(ines)), reply as never),
    );
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(asked).toMatchObject({ status: 'PENDING', kind: 'REFUND', amountCents: 10_000 });
    expect(await availableOf(payment)).toBe(30_000 - 9_999);

    const boss = await newOwner();
    const ownerReply = { status: vi.fn() };
    const direct = await asStaff(V, () =>
      refundsController.create(
        payment,
        { amountCents: 10_000, reason: 'el dueño', totpCode: codeOf(boss) },
        jwtOf(owner(boss)),
        ownerReply as never,
      ),
    );
    expect(direct).toMatchObject({ status: 'SUCCEEDED' });
    expect(ownerReply.status).not.toHaveBeenCalled();

    const pending = await asStaff(V, () => requests.list(owner(boss), { status: 'PENDING', limit: 50 }));
    expect(pending.items.find((i) => i.id === (asked as { approvalRequestId: string }).approvalRequestId)).toMatchObject({
      kind: 'REFUND',
      refund: { paymentId: payment, paymentAmountCents: 30_000, cardLast4: '4242', reason: 'servicio' },
    });
    const done = await approve(await newOwner(), (asked as { approvalRequestId: string }).approvalRequestId);
    expect(done).toMatchObject({ status: 'APPROVED', resultRef: expect.any(String) });
    const refund = await sys<{ status: string; amountCents: number; requestedBy: string }>((tx) =>
      tx.refund.findUniqueOrThrow({ where: { id: done.resultRef! } }),
    );
    expect(refund).toMatchObject({ status: 'SUCCEEDED', amountCents: 10_000, requestedBy: ines });
    expect(await availableOf(payment)).toBe(30_000 - 9_999 - 10_000 - 10_000);
  });

  it('dos peticiones a la vez del mismo cobro no pasan de lo cobrado; lo pedido reserva también para el dueño', async () => {
    const chica = await newChica('Lía');
    const payment = await newPayment(chica, 20_000);
    const [m1, m2] = [await newManager('Cris'), await newManager('Dani')];
    const results = await Promise.allSettled([askRefund(managerOf(m1), payment, 15_000), askRefund(managerOf(m2), payment, 15_000)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((x): x is PromiseRejectedResult => x.status === 'rejected')!;
    expect(String((lost.reason as Error).message)).toMatch(/Solo quedan 5000 céntimos/);
    const asked = (results.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{ approvalRequestId: string }>).value;

    // El dueño no puede devolver por su cuenta lo que ya está pedido; lo que queda, sí.
    const boss = await newOwner();
    const direct = (amountCents: number) =>
      asStaff(V, () => refunds.refund({ paymentId: payment, amountCents, reason: 'directa' }, { userId: boss, role: 'OWNER', tenantId: V }));
    expect(await failure(direct(10_000))).toMatchObject({ status: 409 });
    await expect(direct(5_000)).resolves.toMatchObject({ status: 'SUCCEEDED' });

    await expect(approve(await newOwner(), asked.approvalRequestId)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(await availableOf(payment)).toBe(0);
  });

  it('partirla en trozos en el mismo cobro no se salta al dueño', async () => {
    const chica = await newChica('Noa');
    const payment = await newPayment(chica, 20_000);
    const eli = await newManager('Eli');
    const reply = { status: vi.fn() };
    const piece = (amountCents: number) =>
      asStaff(V, () => refundsController.create(payment, { amountCents }, jwtOf(managerOf(eli)), reply as never));
    await expect(piece(6_000)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(reply.status).not.toHaveBeenCalled();
    // 60 € ya devueltos por ella aquí + 50 € = 110 € ≥ 100 €: al dueño.
    await expect(piece(5_000)).resolves.toMatchObject({ status: 'PENDING', kind: 'REFUND' });
    expect(reply.status).toHaveBeenCalledWith(202);
  });

  it('el dueño apunta una devolución ya hecha en el banco aunque haya una pedida; la pedida falla si ya no cabe', async () => {
    const chica = await newChica('Zoe');
    const payment = await newPayment(chica, 15_000);
    const asked = await askRefund(managerOf(manager), payment, 12_000);
    const boss = await newOwner();
    await expect(
      asStaff(V, () =>
        refunds.registerBankRefund(
          { paymentId: payment, amountCents: 15_000, reason: 'devuelto en el portal de BBVA' },
          { userId: boss, role: 'OWNER', tenantId: V },
        ),
      ),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(await availableOf(payment)).toBe(0);
    const calls = gatewayCalls;
    expect(await failure(approve(await newOwner(), asked.approvalRequestId))).toMatchObject({
      status: 409,
      body: { code: 'APPROVAL_FAILED' },
    });
    expect(gatewayCalls).toBe(calls);
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'FAILED' });
  });

  it('si la pasarela la rechaza al aprobarla: FAILED con la razón y el cobro queda igual', async () => {
    const chica = await newChica('Mía');
    const payment = await newPayment(chica, 15_000);
    const asked = await askRefund(managerOf(manager), payment, 12_000);
    gatewaySays = 'FAILED';
    try {
      expect(await failure(approve(await newOwner(), asked.approvalRequestId))).toMatchObject({
        status: 409,
        body: { code: 'APPROVAL_FAILED' },
      });
    } finally {
      gatewaySays = 'SUCCEEDED';
    }
    const row = await rowOf(asked.approvalRequestId);
    expect(row).toMatchObject({ status: 'FAILED', resultRef: expect.any(String), failureReason: expect.stringMatching(/rechaz/) });
    expect(await availableOf(payment)).toBe(15_000);
    // Ya no reserva: se puede volver a pedir.
    await expect(askRefund(managerOf(manager), payment, 12_000)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('una recarga de saldo o un cobro de Redsys no se piden (se devuelven por su sitio)', async () => {
    const chica = await newChica('Ada');
    const payment = await newPayment(chica, 12_000);
    await sys((tx) => tx.payment.update({ where: { id: payment }, data: { provider: 'REDSYS' } }));
    expect(await failure(askRefund(managerOf(manager), payment, 11_000))).toMatchObject({ status: 409 });
  });
});

describe('bandeja y aislamiento', () => {
  it('pendiente más de 30 min sale en Incidencias; al decidirla se quita', async () => {
    const chica = await newChica('Ruth', [2_000]);
    const asked = await pay(managerOf(manager), chica);
    const kinds = async () =>
      (await asStaff(V, () => incidents.list(V))).filter((i) => i.kind === 'approval_pending').map((i) => i.refId);
    expect(await kinds()).not.toContain(asked.approvalRequestId);
    await sys((tx) =>
      tx.approvalRequest.update({ where: { id: asked.approvalRequestId }, data: { requestedAt: new Date(Date.now() - 40 * 60 * 1000) } }),
    );
    const open = (await asStaff(V, () => incidents.list(V))).find((i) => i.refId === asked.approvalRequestId);
    expect(open).toMatchObject({ kind: 'approval_pending', ackable: false, amountCents: 1_800, title: 'Pago a una chica por aprobar' });
    expect(open?.detail).toMatch(/^Ana pidió pagar 18,00 € a Ruth hace 40 min/);
    await asStaff(V, async () => requests.reject(owner(await newOwner()), asked.approvalRequestId, 'no toca'));
    expect(await kinds()).not.toContain(asked.approvalRequestId);
  });

  it('el dueño de otro local ni la ve ni la decide (RLS)', async () => {
    const chica = await newChica('Alba', [2_000]);
    const asked = await pay(managerOf(manager), chica);
    const other = await newOwner(B);
    const seen = await asStaff(B, () => requests.list(owner(other, B), { limit: 100 }));
    expect(seen.items.map((i) => i.id)).not.toContain(asked.approvalRequestId);
    expect(await failure(approve(other, asked.approvalRequestId, B))).toMatchObject({ status: 404 });
    expect(await failure(asStaff(B, () => requests.reject(owner(other, B), asked.approvalRequestId, 'no es mío')))).toMatchObject({
      status: 404,
    });
    expect(await rowOf(asked.approvalRequestId)).toMatchObject({ status: 'PENDING' });
  });
});
