// «Pagar» a varias a la vez (POST /admin/payout-batches) contra Postgres de
// verdad, con RLS forzado: dos tandas a la vez, una tanda y un pago suelto, la
// misma clave dos veces, una petición «Por aprobar» que entra a mitad y un corte.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { CreatePayoutBatchDto, PayoutBatchResult } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PayoutBatchService } from '../../src/modules/admin/payout-batch.service';
import { ApprovalRequestsService } from '../../src/modules/approvals/approval-requests.service';
import { assertNoPendingPayout } from '../../src/modules/approvals/approval-store';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const auditLog: Array<{ action: string; targetId?: string; payload?: Record<string, unknown> | null }> = [];
const audit = { log: async (e: (typeof auditLog)[number]) => void auditLog.push(e) };
const settings: Record<string, string | number> = { OPERATOR_BASE_URL: 'https://chicas.example.com', PAYOUT_HOLD_DAYS: 7 };
const config = { get: (k: string) => settings[k], getOrThrow: (k: string) => settings[k] };
const fx = { getEurToUsdtRateInfo: async () => ({ rate: 1.07, degraded: false }) };
/** «Te han pagado»: lo que se le mandaría a cada una. */
const pushes: Array<{ operatorId: string; payoutId: string; totalCents: number }> = [];
const staffPush = { payoutMade: (p: (typeof pushes)[number]) => void pushes.push(p) };

const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, fx as never, {} as never, staffPush as never);
const notifier = { enabled: () => false, requested: vi.fn() };
const requests = new ApprovalRequestsService(prisma, audit as never, config as never, notifier as never);
const batches = new PayoutBatchService(prisma, operators, requests, totp, audit as never);

function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-lote-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-lote' });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => asPublic(() => prisma.asSystem(fn)) as Promise<T>;

/** Lo que devuelve la tanda, o el error HTTP con el que falla. */
type Outcome = { ok: PayoutBatchResult } | { status: number; body: Record<string, unknown> };
async function outcome(p: Promise<PayoutBatchResult>): Promise<Outcome> {
  try {
    return { ok: await p };
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const body = err.getResponse();
    return { status: err.getStatus(), body: typeof body === 'string' ? { message: body } : (body as Record<string, unknown>) };
  }
}

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60 * 1000;
let seq = 0;
const uniq = (p: string) => `${p}-${r}-${++seq}`;

let V: string;
let B: string;
let term: string;
const secrets = new Map<string, string>();

async function newUser(tenantId: string, role: 'OWNER' | 'MANAGER', withTotp: boolean): Promise<string> {
  const secret = withTotp ? totp.newSecret() : null;
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: { tenantId, email: `${uniq(role.toLowerCase())}@x.es`, passwordHash: 'x', role, displayName: role, totpSecret: secret ? totp.sealSecret(secret) : null },
      })
    ).id,
  );
  if (secret) secrets.set(id, secret);
  return id;
}
/** Un dueño nuevo con su 2FA (cada tanda con el suyo: un código vale una vez). */
const newOwner = () => newUser(V, 'OWNER', true);
const codeOf = (userId: string) => totpCodeAt(secrets.get(userId)!);

/** Un cobro pagado de una compañera, con su comisión del 90 %. */
async function newPayment(chica: string, amountCents: number, tenantId = V, terminalId = term): Promise<void> {
  await sys(async (tx) => {
    const at = new Date(Date.now() - 2 * HOUR);
    const p = await tx.payment.create({
      data: {
        tenantId, terminalId, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents, availableAmountCents: amountCents,
        createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', authorizedAt: at, createdAt: at, cardLast4: '4242', cardBrand: 'VISA',
      } as never,
    });
    await tx.operatorEarning.create({
      data: { tenantId, operatorId: chica, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000, commissionCents: Math.round(amountCents * 0.9), createdAt: at },
    });
  });
}

const addressOf = new Map<string, string>();
/** Una compañera con su cuenta USDT y cobros ya pagables (el local paga al cierre de la noche). */
async function newChica(payments: number[] = [10_000], over: Record<string, unknown> = {}, tenantId = V, terminalId = term): Promise<string> {
  const address = `TQ${randomUUID().replace(/-/g, '').slice(0, 32)}`;
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: { tenantId, email: `${uniq('chica')}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Chica', payoutMethod: 'USDT_TRC20', payoutAddress: address, ...over } as never,
      })
    ).id,
  );
  addressOf.set(id, address);
  for (const cents of payments) await newPayment(id, cents, tenantId, terminalId);
  return id;
}
const chicas = (n: number) => Promise.all(Array.from({ length: n }, () => newChica()));

type PayoutRow = { id: string; operatorId: string; totalCents: number; paidToAddress: string | null; paidByUserId: string; idempotencyKey: string | null };
const payoutsOf = (ids: string[]) => sys<PayoutRow[]>((tx) => tx.operatorPayout.findMany({ where: { operatorId: { in: ids } } }));
const earningsOf = (ids: string[]) =>
  sys<Array<{ operatorId: string; payoutId: string | null }>>((tx) => tx.operatorEarning.findMany({ where: { operatorId: { in: ids } }, select: { operatorId: true, payoutId: true } }));
const balanceOf = (chica: string) => asStaff(V, () => operators.getBalance(chica, V));
const pendingRequests = (ids: string[]) => sys<number>((tx) => tx.approvalRequest.count({ where: { kind: 'PAYOUT', targetId: { in: ids } } }));

const dtoFor = (ids: string[], totpCode?: string, cents = 9_000): CreatePayoutBatchDto => ({
  items: ids.map((operatorId) => ({ operatorId, expectedTotalCents: cents })),
  ...(totpCode ? { totpCode } : {}),
});
const newKey = () => `tanda-${randomUUID()}`;
const payBatch = (ownerId: string, key: string, ids: string[], withCode = true, svc = batches) =>
  asStaff(V, () => svc.pay({ userId: ownerId, role: 'OWNER', tenantId: V }, key, dtoFor(ids, withCode ? codeOf(ownerId) : undefined)));

/** Cada persona, un solo pago de 90 € con todas sus comisiones liquidadas en él. */
async function expectPaidOnce(ids: string[]): Promise<PayoutRow[]> {
  const payouts = await payoutsOf(ids);
  expect(payouts.map((p) => p.operatorId).sort()).toEqual([...ids].sort());
  for (const p of payouts) expect(p.totalCents).toBe(9_000);
  const earnings = await earningsOf(ids);
  expect(earnings).toHaveLength(ids.length);
  for (const e of earnings) expect(e.payoutId).toBe(payouts.find((p) => p.operatorId === e.operatorId)!.id);
  for (const id of ids) expect(await balanceOf(id)).toMatchObject({ availableCents: 0, pendingCents: 0 });
  return payouts;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, B, term } = await sys<{ V: string; B: string; term: string }>(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Lote ${r}`, slug: `lote-${r}`, payoutHoldDays: 0 } });
    const b = await tx.venue.create({ data: { name: `Lote B ${r}`, slug: `lote-b-${r}`, payoutHoldDays: 0 } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `LT-${r}`, label: 'Barra' } });
    return { V: v.id, B: b.id, term: t.id };
  }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Pagar» a varias a la vez', () => {
  it('seis bien: un pago por persona a la cuenta guardada, su comisión liquidada, un aviso a cada una y un registro sin cuentas', async () => {
    const boss = await newOwner();
    const ids = await chicas(6);
    const key = newKey();
    const res = await payBatch(boss, key, ids);
    expect(res).toMatchObject({ paidCount: 6, paidCents: 54_000 });
    const payouts = await expectPaidOnce(ids);
    expect(res.results).toEqual(ids.map((operatorId) => ({ operatorId, status: 'PAID', payoutId: payouts.find((p) => p.operatorId === operatorId)!.id, totalCents: 9_000 })));
    for (const p of payouts) {
      // La cuenta la pone el API con lo guardado (el cuerpo no la lleva) y queda en el pago.
      expect(p).toMatchObject({ paidToAddress: addressOf.get(p.operatorId), paidByUserId: boss, idempotencyKey: `${key}:${p.operatorId}` });
    }
    expect(pushes.filter((p) => ids.includes(p.operatorId)).map((p) => p.payoutId).sort()).toEqual(payouts.map((p) => p.id).sort());
    const created = auditLog.filter((e) => e.action === 'operator.payout.created' && e.payload?.batchKey === key);
    expect(created).toHaveLength(6);
    const batch = auditLog.filter((e) => e.action === 'operator.payout.batch' && e.payload?.batchKey === key);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ targetId: V, payload: { count: 6, paidCount: 6, paidCents: 54_000 } });
    const out = JSON.stringify([res, batch, created]);
    for (const id of ids) expect(out).not.toContain(addressOf.get(id)!);
  });

  it('la misma clave dos veces (seguidas y a la vez): los mismos pagos, sin otro código, sin otro aviso y sin otro registro', async () => {
    const boss = await newOwner();
    const ids = await chicas(3);
    const key = newKey();
    const first = await payBatch(boss, key, ids);
    const pushesBefore = pushes.length;
    const auditBefore = auditLog.length;
    // Sin código: lo ya apuntado no vuelve a pedir el 2FA.
    const again = await payBatch(boss, key, ids, false);
    expect(again).toEqual(first);
    const [a, b] = await Promise.all([payBatch(boss, key, ids, false), payBatch(boss, key, ids, false)]);
    expect(a).toEqual(first);
    expect(b).toEqual(first);
    await expectPaidOnce(ids);
    expect(pushes.length).toBe(pushesBefore);
    expect(auditLog.length).toBe(auditBefore);
    // Con otra cifra para alguien: 409 y nada más.
    const other = await outcome(
      asStaff(V, () => batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, key, dtoFor(ids, undefined, 8_000))),
    );
    expect(other).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    await expectPaidOnce(ids);
  });

  it('doble envío a la vez de la misma tanda nueva (misma clave): un pago por persona y las dos respuestas dicen esos pagos', async () => {
    const boss = await newOwner();
    const other = await newOwner();
    const ids = await chicas(4);
    const key = newKey();
    // Dos pestañas de la misma persona: la segunda con el código de después (uno vale una vez).
    const dto = (step: number) => ({ ...dtoFor(ids), totpCode: totpCodeAt(secrets.get(boss)!, Math.floor(Date.now() / 30_000) + step) });
    const run = (step: number) => outcome(asStaff(V, () => batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, key, dto(step))));
    const [a, b] = await Promise.all([run(0), run(1)]);
    const payouts = await expectPaidOnce(ids);
    for (const o of [a, b]) {
      // O paga (o repite lo que pagó la otra), o llega tarde a la comprobación y no apunta nada nuevo, o su
      // código ya no vale (la otra pestaña gastó uno posterior): en ningún caso un segundo pago.
      if ('ok' in o) {
        for (const row of o.ok.results) if (row.status === 'PAID') expect(row.payoutId).toBe(payouts.find((p) => p.operatorId === row.operatorId)!.id);
      } else expect(['PAYOUT_BATCH_CHANGED', 'TOTP_INVALID']).toContain(o.body.code);
    }
    expect([a, b].some((o) => 'ok' in o)).toBe(true);
    expect(pushes.filter((p) => ids.includes(p.operatorId))).toHaveLength(4);
    // Otra persona con la misma clave: no se queda con esos pagos ni paga otra vez.
    const stolen = await outcome(payBatch(other, key, ids));
    expect(stolen).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    await expectPaidOnce(ids);
  });

  it('dos tandas a la vez con las mismas personas (dos dueños, dos claves): un pago por persona y las comisiones liquidadas una vez', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [ana, luis] = [await newOwner(), await newOwner()];
      const ids = await chicas(5);
      const [a, b] = await Promise.all([outcome(payBatch(ana, newKey(), ids)), outcome(payBatch(luis, newKey(), [...ids].reverse()))]);
      const payouts = await expectPaidOnce(ids);
      const paidIn = (o: Outcome) => ('ok' in o ? o.ok.results.filter((x) => x.status === 'PAID').map((x) => x.payoutId!) : []);
      // Entre las dos, cada pago sale una vez: nadie cobra dos veces.
      expect([...paidIn(a), ...paidIn(b)].sort()).toEqual(payouts.map((p) => p.id).sort());
      for (const o of [a, b]) {
        if ('ok' in o) {
          for (const row of o.ok.results) if (row.status !== 'PAID') expect(['NOTHING_TO_PAY', 'PAYOUT_CHANGED']).toContain(row.code);
        } else expect(o).toMatchObject({ status: 409, body: { code: 'PAYOUT_BATCH_CHANGED' } });
      }
      expect(pushes.filter((p) => ids.includes(p.operatorId))).toHaveLength(5);
    }
  });

  it('una tanda y un pago suelto a la vez: a esa persona, un solo pago', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [ana, luis] = [await newOwner(), await newOwner()];
      const ids = await chicas(4);
      const target = ids[round % ids.length]!;
      const single = asStaff(V, () =>
        operators.createPayout(V, target, luis, undefined, { expectedTotalCents: 9_000, inTransaction: (tx) => assertNoPendingPayout(tx, V, target) }),
      ).then(
        (p) => p.id,
        (err: unknown) => {
          if (!(err instanceof HttpException) || err.getStatus() !== 409) throw err;
          return null;
        },
      );
      const [batch, singleId] = await Promise.all([outcome(payBatch(ana, newKey(), ids)), single]);
      const rows = await payoutsOf([target]);
      expect(rows).toHaveLength(1);
      if (singleId) expect(rows[0]!.id).toBe(singleId);
      if ('ok' in batch) {
        // Las demás cobran; ella, en la tanda o en el pago suelto, nunca en los dos.
        await expectPaidOnce(ids);
        const row = batch.ok.results.find((x) => x.operatorId === target)!;
        expect(row.status === 'PAID').toBe(singleId === null);
      } else {
        expect(batch).toMatchObject({ status: 409, body: { code: 'PAYOUT_BATCH_CHANGED' } });
        expect(singleId).not.toBeNull();
        expect(await payoutsOf(ids.filter((id) => id !== target))).toEqual([]);
      }
    }
  });

  it('una petición «Por aprobar» que entra entre la comprobación y el pago: esa persona FAILED, las demás PAID', async () => {
    const boss = await newOwner();
    const manager = await newUser(V, 'MANAGER', false);
    const ids = await chicas(3);
    const reserved = ids[1]!;
    // El 2FA va justo entre la comprobación en seco y el primer pago: ahí entra la petición del encargado.
    const totpThenRequest = {
      assertForUser: async (...args: Parameters<TotpService['assertForUser']>) => {
        await totp.assertForUser(...args);
        await requests.requestPayout({ userId: manager, role: 'MANAGER', tenantId: V }, reserved, { externalRail: 'USDT_TRC20', expectedTotalCents: 9_000 });
      },
    };
    const racing = new PayoutBatchService(prisma, operators, requests, totpThenRequest as never, audit as never);
    const res = await payBatch(boss, newKey(), ids, true, racing);
    expect(res.results.map((x) => [x.status, x.code])).toEqual([['PAID', undefined], ['FAILED', 'APPROVAL_ALREADY_PENDING'], ['PAID', undefined]]);
    expect(res).toMatchObject({ paidCount: 2, paidCents: 18_000 });
    expect(await payoutsOf([reserved])).toEqual([]);
    expect(pushes.filter((p) => p.operatorId === reserved)).toEqual([]);
    await expectPaidOnce([ids[0]!, ids[2]!]);
    // Y mientras siga pedida, otra tanda con ella no paga a nadie.
    const next = await chicas(1);
    const blocked = await outcome(payBatch(await newOwner(), newKey(), [reserved, ...next]));
    expect(blocked).toMatchObject({ status: 409, body: { code: 'PAYOUT_BATCH_CHANGED', problems: [{ operatorId: reserved, code: 'APPROVAL_ALREADY_PENDING' }] } });
    expect(await payoutsOf(next)).toEqual([]);
  });

  it('un corte a mitad (falla la base en la tercera): cada pago entero o sin hacer; repetir con la misma clave termina sin pagar dos veces', async () => {
    const boss = await newOwner();
    const ids = await chicas(5);
    const key = newKey();
    const real = operators.createPayout.bind(operators);
    const spy = vi.spyOn(operators, 'createPayout').mockImplementation(async (...args) => {
      if (args[1] !== ids[2]) return real(...args);
      // Se corta DENTRO de la transacción del pago, después de mirar todo: no queda nada a medias.
      return real(args[0], args[1], args[2], args[3], { ...args[4], afterCreate: async () => Promise.reject(new Error('connection terminated unexpectedly')) });
    });
    const cut = await payBatch(boss, key, ids);
    spy.mockRestore();
    expect(cut.results.map((x) => [x.status, x.code])).toEqual([
      ['PAID', undefined], ['PAID', undefined], ['FAILED', 'UNKNOWN'], ['SKIPPED', 'SKIPPED'], ['SKIPPED', 'SKIPPED'],
    ]);
    await expectPaidOnce(ids.slice(0, 2));
    expect(await payoutsOf(ids.slice(2))).toEqual([]);
    for (const e of (await earningsOf(ids.slice(2)))) expect(e.payoutId).toBeNull();
    expect(pushes.filter((p) => ids.includes(p.operatorId)).map((p) => p.operatorId).sort()).toEqual(ids.slice(0, 2).sort());

    // Reintento con la misma clave (y otro código: el primero ya se gastó).
    const retry = await asStaff(V, () =>
      batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, key, dtoFor(ids, totpCodeAt(secrets.get(boss)!, Math.floor(Date.now() / 30_000) + 1))),
    );
    expect(retry).toMatchObject({ paidCount: 5, paidCents: 45_000 });
    expect(retry.results.slice(0, 2)).toEqual(cut.results.slice(0, 2));
    await expectPaidOnce(ids);
    expect(pushes.filter((p) => ids.includes(p.operatorId))).toHaveLength(5);
  });

  it('una cifra que ya no es, en efectivo, sin cuenta, con espera de 48 h, de otro local o de baja: 409, nadie cobra y el código sigue valiendo', async () => {
    const boss = await newOwner();
    const good = await chicas(2);
    const changed = await newChica([10_000, 5_000]);
    const cash = await newChica([10_000], { payoutMethod: 'MANUAL_CASH', payoutAddress: null });
    const noAccount = await newChica([10_000], { payoutMethod: null, payoutAddress: null });
    const until = new Date(Date.now() + 20 * HOUR);
    const tooNew = await newChica([10_000], { payoutHoldUntil: until });
    const gone = await newChica([10_000], { deletedAt: new Date() });
    const termB = await sys<string>(async (tx) => (await tx.terminal.create({ data: { tenantId: B, externalId: uniq('LB'), label: 'Barra' } })).id);
    const foreign = await newChica([10_000], {}, B, termB);
    const ghost = randomUUID();
    const everyone = [...good, changed, cash, noAccount, tooNew, gone, foreign, ghost];
    const code = codeOf(boss);
    const res = await outcome(asStaff(V, () => batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, newKey(), dtoFor(everyone, code))));
    expect(res).toMatchObject({
      status: 409,
      body: {
        code: 'PAYOUT_BATCH_CHANGED',
        problems: [
          { operatorId: changed, code: 'PAYOUT_CHANGED', totalCents: 13_500 },
          { operatorId: cash, code: 'CASH' },
          { operatorId: noAccount, code: 'NO_ACCOUNT' },
          { operatorId: tooNew, code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: until.toISOString() },
          // De baja, de otro local o inventada: exactamente lo mismo.
          { operatorId: gone, code: 'NOT_FOUND' },
          { operatorId: foreign, code: 'NOT_FOUND' },
          { operatorId: ghost, code: 'NOT_FOUND' },
        ],
      },
    });
    const problems = (res as { body: { problems: Array<Record<string, unknown>> } }).body.problems;
    expect(Object.keys(problems[5]!).sort()).toEqual(Object.keys(problems[6]!).sort());
    expect(await payoutsOf(everyone)).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(addressOf.get(tooNew)!);
    // El código no se gastó: con la lista buena, el mismo paga.
    const ok = await asStaff(V, () => batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, newKey(), dtoFor(good, code)));
    expect(ok).toMatchObject({ paidCount: 2 });
    // El mismo código otra vez: ya no.
    const more = await chicas(1);
    const reused = await outcome(asStaff(V, () => batches.pay({ userId: boss, role: 'OWNER', tenantId: V }, newKey(), dtoFor(more, code))));
    expect(reused).toMatchObject({ status: 403, body: { code: 'TOTP_INVALID' } });
    expect(await payoutsOf(more)).toEqual([]);
    // Y la de otro local sigue sin pago en el suyo.
    expect(await payoutsOf([foreign])).toEqual([]);
  });

  it('el encargado de un local donde el dueño aprueba los pagos: 409 y ni paga ni deja nada pedido; sin 2FA ni llave, 403', async () => {
    const manager = await newUser(V, 'MANAGER', true);
    const ids = await chicas(2);
    const res = await outcome(
      asStaff(V, () => batches.pay({ userId: manager, role: 'MANAGER', tenantId: V }, newKey(), dtoFor(ids, codeOf(manager)))),
    );
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_BATCH_NEEDS_APPROVAL' } });
    expect(await pendingRequests(ids)).toBe(0);
    expect(await payoutsOf(ids)).toEqual([]);

    const bare = await newUser(V, 'OWNER', false);
    const denied = await outcome(asStaff(V, () => batches.pay({ userId: bare, role: 'OWNER', tenantId: V }, newKey(), dtoFor(ids))));
    expect(denied).toMatchObject({ status: 403, body: { code: 'TOTP_NOT_ENROLLED', message: expect.stringMatching(/^Para pagar a varias a la vez/) } });
    expect(await payoutsOf(ids)).toEqual([]);
  });
});
