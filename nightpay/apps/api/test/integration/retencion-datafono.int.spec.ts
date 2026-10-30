// Integración (Postgres real): la comisión de una venta por datáfono sin prueba del banco (H-1) no se paga
// hasta cuadrarla con el banco o que el dueño la libere con su 2FA. Con el rol sin superusuario (FORCE RLS)
// y el local en el contexto, como tras AuthGuard. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { CreatePayoutDto } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { BankHoldsService } from '../../src/modules/operators/bank-holds.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { PeanpeAdapter } from '../../src/modules/gateways/peanpe.adapter';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { TreasuryService } from '../../src/modules/treasury/treasury.service';
import { ApprovalRequestsService, type ApprovalActor } from '../../src/modules/approvals/approval-requests.service';
import { ApprovalsService } from '../../src/modules/approvals/approvals.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const auditLog: Array<{ action: string; targetId?: string; actorId?: string; payload?: Record<string, unknown> | null }> = [];
const audit = { log: async (e: (typeof auditLog)[number]) => void auditLog.push(e) };
const settings: Record<string, string | number> = {
  OPERATOR_BASE_URL: 'https://chicas.example.com',
  PAYOUT_HOLD_DAYS: 0,
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
  { get: () => ({}) } as never,
  payments,
  totp,
  audit as never,
  { refundsCreated: { inc: vi.fn() }, earningReversalFailed: { inc: vi.fn() } } as never,
);
// «Liberar» apunta su registro dentro de su transacción: aquí, en audit_events de verdad.
const holds = new BankHoldsService(prisma, totp, new AuditService(prisma, cls as never));
const incidents = new IncidentsService(prisma, audit as never);
const closeChecks = new CloseCheckService(prisma, incidents, config as never);
const treasury = new TreasuryService(prisma, audit as never, {} as never, config as never);
const requests = new ApprovalRequestsService(prisma, audit as never, config as never, { enabled: () => false, requested: vi.fn() } as never);
const approvals = new ApprovalsService(prisma, requests, operators, refunds, totp, audit as never);

/** Una petición del panel de ese local (como tras AuthGuard). */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-ret-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-ret' });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => asPublic(() => prisma.asSystem(fn)) as Promise<T>;

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
const secrets = new Map<string, string>();

let V: string;
let term: string;
let waiter: string;

async function newUser(role: 'OWNER' | 'MANAGER' | 'WAITER', name: string, withTotp: boolean): Promise<string> {
  const secret = withTotp ? totp.newSecret() : null;
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId: V,
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
const codeOf = (userId: string) => totpCodeAt(secrets.get(userId)!);
/** Un dueño nuevo con su 2FA: un código vale una sola vez (cada uso, el suyo). */
const freshOwner = (name = 'Dueño') => newUser('OWNER', name, true);
const ownerActor = (userId: string): ApprovalActor => ({ userId, role: 'OWNER', tenantId: V });

async function newChica(name: string): Promise<string> {
  return sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId: V, email: `${uniq('chica')}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: name,
          payoutMethod: 'MANUAL_CASH',
        } as never,
      })
    ).id,
  );
}

/** Un cobro con tarjeta probado por el banco (Paytef enlace): su comisión del 90 % se paga como siempre. */
async function provenSale(chica: string, amountCents: number): Promise<string> {
  return sys<string>(async (tx) => {
    const at = new Date(Date.now() - 2 * HOUR);
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents, availableAmountCents: amountCents,
        createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', authorizedAt: at, createdAt: at,
      } as never,
    });
    await tx.operatorEarning.create({
      data: { tenantId: V, operatorId: chica, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000, commissionCents: Math.round(amountCents * 0.9), createdAt: at },
    });
    return p.id;
  });
}

/** Un cobro por datáfono externo que crea quien se diga y confirma un camarero (o quien se diga) con el código del ticket. */
async function posSale(createdBy: string, amountCents: number, confirmer: { userId: string; role: string } = { userId: waiter, role: 'WAITER' }): Promise<string> {
  const id = await sys<string>(async (tx) =>
    (
      await tx.payment.create({
        data: {
          tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
          status: 'CREATED', captureMethod: 'POS_EXTERNAL', amountCents, availableAmountCents: amountCents,
          createdByUserId: createdBy, revenueCategory: 'CHICA_SERVICE',
        } as never,
      })
    ).id,
  );
  const ref = `T${String(++seq).padStart(5, '0')}`.slice(0, 6);
  await asStaff(V, () => payments.confirmPosPayment(id, { ...confirmer, tenantId: V }, { posReceiptRef: ref, chargedCents: amountCents }));
  return id;
}

/** El fichero del banco casa (o no) ese cobro. */
async function bankLine(paymentId: string, status: 'MATCHED' | 'AMOUNT_MISMATCH', superseded = false): Promise<string> {
  return sys<string>(async (tx) => {
    const st = await tx.bankStatement.create({
      data: {
        tenantId: V, source: 'PAYTEF', fileName: 'paytef.csv', fileSha256: uniq('sha'), periodFrom: new Date('2026-10-01'),
        periodTo: new Date('2026-10-31'), rowsTotal: 1, matchedCount: 1, problemCount: 0, bankTotalCents: 0, oursTotalCents: 0,
        uploadedByUserId: waiter,
      },
    });
    const item = await tx.bankStatementItem.create({
      data: { statementId: st.id, tenantId: V, status, kind: 'SALE', paymentId, supersededAt: superseded ? new Date() : null },
    });
    return item.id;
  });
}

const balanceOf = (chica: string) => asStaff(V, () => operators.getBalance(chica, V));
const unpaidEarnings = (chica: string) =>
  sys<Array<{ paymentId: string | null }>>((tx) => tx.operatorEarning.findMany({ where: { operatorId: chica, payoutId: null }, select: { paymentId: true } }));
const pay = (chica: string, by: string, dto: Partial<CreatePayoutDto> = {}) =>
  asStaff(V, () => operators.createPayout(V, chica, by, dto.notes, { expectedTotalCents: dto.expectedTotalCents }));

let owner: string;
let manager: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Retención', slug: `ret-${r}`, payoutHoldDays: 0 } as never })).id;
    term = (await tx.terminal.create({ data: { tenantId: V, externalId: `TR-${r}`, label: 'Barra' } })).id;
  });
  waiter = await newUser('WAITER', 'Carlos', false);
  owner = await newUser('OWNER', 'Daniel', true);
  manager = await newUser('MANAGER', 'Lucía', false);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('comisión de ventas por datáfono sin cuadrar con el banco (Postgres real)', () => {
  it('el pago a la chica excluye lo retenido; el saldo y la vista previa lo enseñan aparte', async () => {
    const chica = await newChica('Ana');
    await provenSale(chica, 10_000);
    const pos = await posSale(chica, 20_000);

    const b = await balanceOf(chica);
    expect(b.availableCents).toBe(9_000);
    expect(b.bankHeldCents).toBe(18_000);
    expect(b.bankHeldCount).toBe(1);
    expect(b.heldCents).toBe(0);

    const list = await asStaff(V, () => holds.listForOperator(V, chica, { userId: owner, role: 'OWNER' }));
    expect(list).toMatchObject({ totalCents: 18_000, count: 1 });
    expect(list.sales[0]).toMatchObject({ paymentId: pos, chargedCents: 20_000, shareCents: 18_000, via: 'camarero', confirmedBy: 'Carlos', releaseBlock: null });

    // El encargado ve la lista pero no puede liberar.
    const seen = await asStaff(V, () => holds.listForOperator(V, chica, { userId: manager, role: 'MANAGER' }));
    expect(seen.sales[0]?.releaseBlock).toBe('not_owner');

    // El dueño paga lo que ve (90 €): la venta por datáfono no entra.
    const payout = await pay(chica, owner, { expectedTotalCents: 9_000 });
    expect(payout).toMatchObject({ totalCents: 9_000, earningCount: 1 });
    expect(await unpaidEarnings(chica)).toEqual([{ paymentId: pos }]);
    // Con solo lo retenido, no hay nada que pagar y se dice por qué.
    const nothing = await failure(pay(chica, owner));
    expect(nothing.status).toBe(409);
    expect(String(nothing.body.message)).toMatch(/pendientes? de cuadrar con el banco/);

    // Cierre de la noche y Tesorería: «a pagar» sin lo retenido.
    const check = await asStaff(V, () =>
      closeChecks.check(V, { id: randomUUID(), openedAt: new Date(Date.now() - 6 * HOUR), openingFloatCents: null }, { from: new Date(Date.now() - 6 * HOUR), to: new Date() }, new Date()),
    );
    const ana = check.chicas.find((c) => c.operatorId === chica)!;
    expect(ana).toMatchObject({ toPayCents: 0, bankHeldCents: 18_000 });
    const stats = await asStaff(V, () => treasury.getStats(V));
    expect(stats.bankHeldPayoutsCents).toBeGreaterThanOrEqual(18_000);
  });

  it('el cuadre con el banco (MATCHED vigente) la libera sola; uno sustituido o con otro importe, no', async () => {
    const chica = await newChica('Bea');
    const pos = await posSale(chica, 20_000);
    await bankLine(pos, 'MATCHED', true);
    await bankLine(pos, 'AMOUNT_MISMATCH');
    expect((await balanceOf(chica)).availableCents).toBe(0);

    await bankLine(pos, 'MATCHED');
    const b = await balanceOf(chica);
    expect(b).toMatchObject({ availableCents: 18_000, bankHeldCents: 0 });
    expect(await pay(chica, owner, { expectedTotalCents: 18_000 })).toMatchObject({ totalCents: 18_000, earningCount: 1 });
  });

  it('el dueño la libera con su 2FA (y queda registrado); sin código o con uno malo, no; repetir no hace nada', async () => {
    const chica = await newChica('Carla');
    const pos = await posSale(chica, 30_000);
    const owner = await freshOwner();

    expect((await failure(asStaff(V, () => holds.release(ownerActor(owner), pos, { totpCode: '' as never })))).status).toBe(403);
    expect((await failure(asStaff(V, () => holds.release(ownerActor(owner), pos, { totpCode: '000000' })))).status).toBe(403);
    expect((await balanceOf(chica)).bankHeldCents).toBe(27_000);

    const meta = { ip: '203.0.113.7', userAgent: 'Prueba/1.0 (retencion)' };
    const done = await asStaff(V, () => holds.release(ownerActor(owner), pos, { totpCode: codeOf(owner), note: 'Visto en el extracto' }, meta));
    expect(done).toEqual({ paymentId: pos, status: 'RELEASED' });
    expect(await balanceOf(chica)).toMatchObject({ availableCents: 27_000, bankHeldCents: 0 });
    const events = await sys<Array<{ eventType: string; payload: unknown }>>((tx) =>
      tx.paymentEvent.findMany({ where: { paymentId: pos, eventType: 'pos.bank_released' }, select: { eventType: true, payload: true } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ releasedByUserId: owner, note: 'Visto en el extracto' });
    const released = () =>
      sys<Array<{ actorId: string | null; tenantId: string | null; ip: string | null; userAgent: string | null; payload: unknown }>>((tx) =>
        tx.auditEvent.findMany({
          where: { action: 'pos.bank_hold_released', targetId: pos },
          select: { actorId: true, tenantId: true, ip: true, userAgent: true, payload: true },
        }),
      );
    const rows = await released();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: owner, tenantId: V, ip: meta.ip, userAgent: meta.userAgent });
    expect(rows[0]!.payload).toMatchObject({ chargedCents: 30_000, note: 'Visto en el extracto' });

    // Otra vez (doble toque): sin pedir otro código ni apuntar nada más.
    expect(await asStaff(V, () => holds.release(ownerActor(owner), pos, { totpCode: '123456' }))).toEqual({ paymentId: pos, status: 'ALREADY_RELEASED' });
    expect(await released()).toHaveLength(1);
    expect(await pay(chica, owner, { expectedTotalCents: 27_000 })).toMatchObject({ totalCents: 27_000 });
  });

  it('quien apuntó o confirmó la venta no la libera (ni el encargado)', async () => {
    const chica = await newChica('Dana');
    const confirmer = await freshOwner('Confirma');
    const creator = await freshOwner('Apunta');
    const releaser = await freshOwner('Libera');
    // La confirmó un dueño en el datáfono: él no la libera; otro dueño, sí.
    const byOwner = await posSale(chica, 10_000, { userId: confirmer, role: 'OWNER' });
    const own = await failure(asStaff(V, () => holds.release(ownerActor(confirmer), byOwner, { totpCode: codeOf(confirmer) })));
    expect(own).toMatchObject({ status: 403, body: { code: 'BANK_RELEASE_OWN_SALE' } });
    const list = await asStaff(V, () => holds.listForOperator(V, chica, { userId: confirmer, role: 'OWNER' }));
    expect(list.sales[0]?.releaseBlock).toBe('own_sale');
    // La apuntó (creó) otro dueño: tampoco él.
    const created = await posSale(creator, 5_000);
    const mine = await failure(asStaff(V, () => holds.release(ownerActor(creator), created, { totpCode: codeOf(creator) })));
    expect(mine.body.code).toBe('BANK_RELEASE_OWN_SALE');
    // El encargado nunca.
    const mgr = await failure(asStaff(V, () => holds.release({ userId: manager, role: 'MANAGER', tenantId: V }, byOwner, { totpCode: '123456' })));
    expect(mgr).toMatchObject({ status: 403, body: { code: 'BANK_RELEASE_OWNER_ONLY' } });
    expect((await balanceOf(chica)).bankHeldCents).toBe(9_000);

    expect(await asStaff(V, () => holds.release(ownerActor(releaser), byOwner, { totpCode: codeOf(releaser) }))).toMatchObject({ status: 'RELEASED' });
    expect((await balanceOf(chica)).bankHeldCents).toBe(0);
    // Un cobro con tarjeta (probado por el banco) no es una venta retenida.
    const card = await provenSale(chica, 1_000);
    expect((await failure(asStaff(V, () => holds.release(ownerActor(releaser), card, { totpCode: '123456' })))).body.code).toBe('BANK_HOLD_NONE');
  });

  it('«Por aprobar» no incluye las retenidas; si se vuelve a retener antes de aprobar, no se paga nada', async () => {
    const chica = await newChica('Eva');
    await provenSale(chica, 10_000);
    const pos = await posSale(chica, 20_000);
    const item = await bankLine(pos, 'MATCHED');
    const mgr = { userId: manager, role: 'MANAGER' as const, tenantId: V };
    const asked = await asStaff(V, () => requests.requestPayout(mgr, chica, { externalRail: 'MANUAL_CASH' } as CreatePayoutDto));
    expect(asked.amountCents).toBe(27_000);
    // Un fichero nuevo sustituye el cuadre y ya no casa: vuelve a estar retenida.
    await sys((tx) => tx.bankStatementItem.update({ where: { id: item }, data: { supersededAt: new Date() } }));
    const first = await freshOwner();
    const approved = await failure(asStaff(V, () => approvals.approve(ownerActor(first), asked.approvalRequestId, codeOf(first))));
    expect(approved).toMatchObject({ status: 409, body: { code: 'PAYOUT_CHANGED' } });
    expect(await unpaidEarnings(chica)).toHaveLength(2);

    // La nueva petición fija solo lo no retenido.
    const again = await asStaff(V, () => requests.requestPayout(mgr, chica, { externalRail: 'MANUAL_CASH' } as CreatePayoutDto));
    expect(again.amountCents).toBe(9_000);
    const second = await freshOwner();
    await asStaff(V, () => approvals.approve(ownerActor(second), again.approvalRequestId, codeOf(second)));
    expect(await unpaidEarnings(chica)).toEqual([{ paymentId: pos }]);
  });

  it('una venta del PAX sin la prueba de Paytef también se retiene; una con la prueba, no', async () => {
    const chica = await newChica('Flor');
    const unproven = await provenSale(chica, 10_000);
    const proven = await provenSale(chica, 5_000);
    await sys(async (tx) => {
      for (const [id, type] of [[unproven, 'pos.device_unproven'], [proven, 'pos.device_confirmed']] as const) {
        await tx.paymentEvent.create({ data: { paymentId: id, tenantId: V, eventType: type, payload: {}, traceId: 't' } });
      }
    });
    expect(await balanceOf(chica)).toMatchObject({ availableCents: 4_500, bankHeldCents: 9_000 });
    const list = await asStaff(V, () => holds.listForOperator(V, chica, { userId: owner, role: 'OWNER' }));
    expect(list.sales.map((s) => [s.paymentId, s.via])).toEqual([[unproven, 'datafono']]);
  });

  it('las deudas y las devoluciones: lo retenido no tapa una deuda y lo devuelto deja de retenerse', async () => {
    const chica = await newChica('Gala');
    const pos = await posSale(chica, 20_000);
    const card = await provenSale(chica, 2_000);
    // Deuda de 50 € de una devolución que llegó con una comisión ya pagada.
    await sys(async (tx) => {
      const old = await tx.payment.create({
        data: {
          tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
          status: 'REFUNDED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents: 6_000, availableAmountCents: 0,
          createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', authorizedAt: new Date(Date.now() - 48 * HOUR),
        } as never,
      });
      const po = await tx.operatorPayout.create({ data: { tenantId: V, operatorId: chica, totalCents: 5_400, paidByUserId: owner } });
      const e = await tx.operatorEarning.create({
        data: { tenantId: V, operatorId: chica, paymentId: old.id, paymentAmountCents: 6_000, commissionBps: 9000, commissionCents: 5_400, payoutId: po.id },
      });
      const refund = await tx.refund.create({
        data: { tenantId: V, paymentId: old.id, amountCents: 5_556, requestedBy: owner, status: 'SUCCEEDED', reason: 'prueba' },
      });
      await tx.earningReversal.create({ data: { tenantId: V, earningId: e.id, refundId: refund.id, reversedDeltaCents: 5_000, afterPayout: true } });
    });
    const b = await balanceOf(chica);
    expect(b).toMatchObject({ bankHeldCents: 18_000, debtCents: 5_000, availableCents: 1_800 - 5_000 });
    expect((await failure(pay(chica, owner))).status).toBe(409);

    // Devuelta entera la venta retenida: ya no hay nada que retener ni que liberar.
    await sys((tx) => tx.operatorEarning.updateMany({ where: { paymentId: pos }, data: { reversedCents: 18_000 } }));
    const after = await asStaff(V, () => holds.listForOperator(V, chica, { userId: owner, role: 'OWNER' }));
    expect(after).toEqual({ totalCents: 0, count: 0, sales: [] });
    expect((await balanceOf(chica)).bankHeldCents).toBe(0);
    expect(card).toBeTruthy();
  });

  it('Incidencias: las ventas por datáfono sin cuadrar (también las del camarero), hasta cuadrarlas o liberarlas', async () => {
    const chica = await newChica('Hana');
    const pos = await posSale(chica, 7_000);
    const open = await asStaff(V, () => incidents.list(V));
    const unproven = open.filter((i) => i.kind === 'pos_unproven_sales');
    expect(unproven.length).toBeGreaterThan(0);
    expect(unproven.map((i) => i.title).join(' ')).toMatch(/sin cuadrar con el banco/);
    const before = unproven.reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
    const releaser = await freshOwner();
    await asStaff(V, () => holds.release(ownerActor(releaser), pos, { totpCode: codeOf(releaser) }));
    const later = (await asStaff(V, () => incidents.list(V))).filter((i) => i.kind === 'pos_unproven_sales');
    expect(later.reduce((sum, i) => sum + (i.amountCents ?? 0), 0)).toBe(before - 7_000);
    expect(chica).toBeTruthy();
  });
});
