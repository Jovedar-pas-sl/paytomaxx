import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PayoutBatchResultSchema, stepUpActions, type CreatePayoutBatchDto, type Role } from '@nightpay/contracts';
import { payoutRoute } from '../approvals/approval-rules';
import { LockoutService } from '../auth/lockout.service';
import { StepUpTokens } from '../auth/step-up-tokens';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../auth/totp-attempts.service';
import { sealTotpSecret } from '../auth/totp-crypto';
import { TotpService } from '../auth/totp.service';
import { claimStepScript, createFakeRedis } from '../auth/testing/fake-redis';
import { totpCodeAt } from '../auth/testing/totp-kit';
import { payoutKeyReused } from '../operators/payout-idempotency';
import { payoutTotalChanged } from '../operators/payout-selection';
import { idempotencyHashOf } from '../payments/idempotency';
import { PAYOUT_BATCH_2FA_MESSAGE, PayoutBatchService } from './payout-batch.service';

// Sala Bambú (Madrid): Javier Ortega, el dueño, paga de una vez a seis compañeras.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OWNER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const SID = '11111111-1111-4111-8111-111111111111';
const KEY = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const NOW = new Date('2026-11-26T02:10:10Z');
const IBAN = 'ES9121000418450200051332';
const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const NAMES = ['Lucía', 'Nerea', 'Carla', 'Sofía', 'Irene', 'Marta'];
const ids = NAMES.map((_, i) => `a1c3e5f7-2b4d-4e6f-8a0b-00000000000${i + 1}`);
const payoutIdOf = (operatorId: string) => operatorId.replace('a1c3e5f7', '9a8b7c6d');
const OTHER_VENUE = 'b2d4f6a8-2b4d-4e6f-8a0b-0000000000ff';

interface Person {
  id: string;
  displayName: string | null;
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutHoldUntil: Date | null;
  payoutMetadata: unknown;
  legalName: string | null;
  payoutHolderConfirmedAt: Date | null;
}

const person = (i: number, over: Partial<Person> = {}): Person => ({
  id: ids[i]!,
  displayName: NAMES[i]!,
  payoutMethod: i % 2 === 0 ? 'SEPA_IBAN' : 'USDT_TRC20',
  payoutAddress: i % 2 === 0 ? IBAN : TRON,
  payoutHoldUntil: null,
  payoutMetadata: null,
  legalName: null,
  payoutHolderConfirmedAt: null,
  ...over,
});

interface Opts {
  role?: Role;
  /** El local pide que el dueño apruebe los pagos del encargado. */
  payoutRequiresApproval?: boolean;
  people?: Person[];
  /** Lo pagable de cada una (por defecto 90,00 €). */
  available?: Record<string, number>;
  /** Peticiones «Por aprobar» pendientes (id de la persona → importe). */
  pending?: Record<string, number>;
  /** Pagos ya apuntados con la clave de la tanda (id de la persona → total). */
  recorded?: Record<string, number>;
  /** La 2FA de quien paga: su secreto, o null (sin 2FA). */
  secret?: string | null;
  passkeys?: number;
}

function setup(opts: Opts = {}) {
  const role = opts.role ?? 'OWNER';
  const people = new Map((opts.people ?? NAMES.map((_, i) => person(i))).map((p) => [p.id, p]));
  const pending = new Map(Object.entries(opts.pending ?? {}));
  const available = (id: string) => opts.available?.[id] ?? 9_000;
  const order: string[] = [];

  const tx = {
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; tenantId: string; deletedAt: null; role: { in: string[] } } }) => {
        if (where.tenantId !== TENANT || where.deletedAt !== null || !where.role.in.includes('OPERATOR')) throw new Error('filtro del local');
        return where.id.in.flatMap((id) => (people.has(id) ? [{ ...people.get(id)! }] : []));
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string; deletedAt: null } }) => {
        if (where.tenantId !== TENANT || where.deletedAt !== null) throw new Error('filtro del local');
        return people.has(where.id) ? { ...people.get(where.id)! } : null;
      }),
    },
    approvalRequest: {
      findFirst: vi.fn(async ({ where }: { where: { targetId: string } }) =>
        pending.has(where.targetId) ? { id: 'ap-1', amountCents: pending.get(where.targetId)! } : null,
      ),
    },
  };
  const prisma = { withTenant: vi.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)) };

  const view = (operatorId: string, totalCents: number) => ({
    id: payoutIdOf(operatorId),
    totalCents,
    earningCount: 2,
    createdAt: NOW.toISOString(),
  });
  const hashOf = (operatorId: string, expectedTotalCents: number) => idempotencyHashOf(OWNER, { batch: true, operatorId, expectedTotalCents });
  const operators = {
    findPayoutReplay: vi.fn(async (_t: string, operatorId: string, _by: string, idem: { key: string; hash: string }) => {
      const total = opts.recorded?.[operatorId];
      if (total === undefined) return null;
      if (idem.hash !== hashOf(operatorId, total)) throw payoutKeyReused();
      return view(operatorId, total);
    }),
    getBalance: vi.fn(async (operatorId: string) => ({ availableCents: available(operatorId), pendingCents: available(operatorId) })),
    // Como el de verdad: lo que comprueba la ruta va dentro de su transacción, con el candado tomado.
    createPayout: vi.fn(
      async (
        _t: string,
        operatorId: string,
        _by: string,
        _notes: string | undefined,
        options: { expectedTotalCents: number; inTransaction: (t: typeof tx) => Promise<void> },
      ) => {
        order.push(`pago:${operatorId}`);
        await options.inTransaction(tx);
        return view(operatorId, options.expectedTotalCents);
      },
    ),
  };
  const approvals = {
    payoutRouteFor: vi.fn(async (actor: { role: Role }) =>
      payoutRoute(actor.role, { payoutRequiresApproval: opts.payoutRequiresApproval ?? false, refundApprovalThresholdCents: 10_000 }),
    ),
    requestPayout: vi.fn(),
  };
  const audit = { log: vi.fn(async (_e: { action: string; payload?: Record<string, unknown> }) => undefined) };

  // La 2FA de verdad (TotpService) sobre un Redis en memoria: códigos de un uso y pruebas de la llave.
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  const tokens = new StepUpTokens(redis as never);
  const cls = new ClsService(new AsyncLocalStorage());
  const stored = opts.secret === undefined ? sealTotpSecret(SECRET, KEK) : opts.secret === null ? null : sealTotpSecret(opts.secret, KEK);
  const totpPrisma = {
    acrossVenues: async (fn: (t: unknown) => unknown) => fn({ user: { findUnique: async () => ({ totpSecret: stored }) } }),
    staffPasskey: { count: vi.fn(async () => opts.passkeys ?? 0) },
  };
  const totp = new TotpService(
    totpPrisma as never,
    new TotpAttemptsService(new LockoutService(redis as never), redis as never),
    tokens,
    cls as never,
  );
  const assertForUser = vi.spyOn(totp, 'assertForUser').mockImplementation(async function (this: TotpService, ...args) {
    order.push('2fa');
    return TotpService.prototype.assertForUser.apply(totp, args);
  });

  const svc = new PayoutBatchService(prisma as never, operators as never, approvals as never, totp, audit as never);
  const actor = { userId: OWNER, role, tenantId: TENANT };
  /** Una petición de quien paga, en su sesión (con la cabecera X-Step-Up-Token si trae prueba). */
  const pay = (dto: CreatePayoutBatchDto, o: { key?: string; proof?: string } = {}) =>
    cls.run(async () => {
      cls.set('ctx', { userId: OWNER, sessionId: SID, ...(o.proof ? { stepUpToken: o.proof } : {}) } as never);
      return svc.pay(actor, o.key ?? KEY, dto);
    });
  const batchAudit = () => audit.log.mock.calls.map((c) => c[0]).filter((e) => e.action === 'operator.payout.batch');
  return { svc, pay, tx, prisma, operators, approvals, audit, totp, tokens, assertForUser, order, people, pending, hashOf, batchAudit };
}

const items = (n = 6, cents = 9_000) => ids.slice(0, n).map((operatorId) => ({ operatorId, expectedTotalCents: cents }));
const code = () => totpCodeAt(SECRET);
const body = (n = 6, cents = 9_000): CreatePayoutBatchDto => ({ items: items(n, cents), totpCode: code() });

async function failure(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const res = err.getResponse();
  return { status: err.getStatus(), body: typeof res === 'string' ? { message: res } : (res as Record<string, unknown>) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.ENCRYPTION_KEK = KEK;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('«Pagar» a varias a la vez — las seis bien', () => {
  it('seis pagos, cada uno con su clave, su huella y la clave de la tanda; un solo 2FA, antes del primero', async () => {
    const s = setup();
    const res = await s.pay(body());
    expect(PayoutBatchResultSchema.parse(res)).toEqual(res);
    expect(res).toEqual({
      results: ids.map((operatorId) => ({ operatorId, status: 'PAID', payoutId: payoutIdOf(operatorId), totalCents: 9_000 })),
      paidCount: 6,
      paidCents: 54_000,
    });
    expect(s.operators.createPayout).toHaveBeenCalledTimes(6);
    ids.forEach((operatorId, i) => {
      const [tenantId, id, by, notes, options] = s.operators.createPayout.mock.calls[i]! as unknown as [string, string, string, undefined, Record<string, unknown>];
      expect([tenantId, id, by, notes]).toEqual([TENANT, operatorId, OWNER, undefined]);
      expect(options).toEqual({
        expectedTotalCents: 9_000,
        idempotency: { key: `${KEY}:${operatorId}`, hash: s.hashOf(operatorId, 9_000) },
        batchKey: KEY,
        inTransaction: expect.any(Function),
      });
    });
    expect(s.assertForUser).toHaveBeenCalledTimes(1);
    expect(s.assertForUser).toHaveBeenCalledWith(OWNER, body().totpCode, stepUpActions.payoutBatch(KEY, 6, 54_000), PAYOUT_BATCH_2FA_MESSAGE);
    expect(s.order).toEqual(['2fa', ...ids.map((id) => `pago:${id}`)]);
  });

  it('la huella no lleva el código 2FA (cambia cada 30 s) y sí a quién y cuánto', async () => {
    const s = setup();
    expect(s.hashOf(ids[0]!, 9_000)).not.toBe(s.hashOf(ids[0]!, 9_001));
    expect(s.hashOf(ids[0]!, 9_000)).not.toBe(s.hashOf(ids[1]!, 9_000));
    expect(s.hashOf(ids[0]!, 9_000)).not.toBe(idempotencyHashOf('otra-persona', { batch: true, operatorId: ids[0]!, expectedTotalCents: 9_000 }));
  });

  it('el registro de la tanda: el total y, por persona, cómo quedó y su pago; sin cuentas', async () => {
    const s = setup();
    await s.pay(body());
    expect(s.batchAudit()).toHaveLength(1);
    expect(s.batchAudit()[0]).toEqual({
      action: 'operator.payout.batch',
      tenantId: TENANT,
      actorId: OWNER,
      targetType: 'Venue',
      targetId: TENANT,
      payload: {
        batchKey: KEY,
        count: 6,
        paidCount: 6,
        paidCents: 54_000,
        results: ids.map((operatorId) => ({ operatorId, status: 'PAID', payoutId: payoutIdOf(operatorId) })),
      },
    });
    const everything = JSON.stringify([s.audit.log.mock.calls, await setup().pay(body())]);
    for (const secret of [IBAN, TRON, 'payoutAddress', 'paidToAddress']) expect(everything).not.toContain(secret);
  });

  it('el mensaje de quien no tiene 2FA ni llave es el de la tanda', () => {
    expect(PAYOUT_BATCH_2FA_MESSAGE).toBe(
      'Para pagar a varias a la vez hace falta la verificación en dos pasos o una llave de acceso (Ajustes → Seguridad). Mientras, págales una a una.',
    );
  });
});

describe('«Pagar» a varias a la vez — algo cambió antes de pagar (comprobación en seco)', () => {
  it('una cifra distinta: 409 PAYOUT_BATCH_CHANGED con la de ahora, ningún pago y el código sin gastar', async () => {
    const s = setup({ available: { [ids[2]!]: 12_500 } });
    const res = await failure(s.pay(body()));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'PAYOUT_BATCH_CHANGED',
      message: 'Algo ha cambiado desde que abriste la lista: no se ha apuntado ningún pago nuevo.',
      problems: [{ operatorId: ids[2], code: 'PAYOUT_CHANGED', totalCents: 12_500 }],
    });
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.assertForUser).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
    // El mismo código vale después (no se gastó): con la lista al día, paga.
    const again = setup();
    await again.pay(body());
    expect(again.operators.createPayout).toHaveBeenCalledTimes(6);
  });

  it('el código que no se gastó en el 409 sigue valiendo en la misma app', async () => {
    const s = setup({ available: { [ids[0]!]: 1 } });
    const dto = body();
    expect((await failure(s.pay(dto))).body.code).toBe('PAYOUT_BATCH_CHANGED');
    // Lo mismo que vio el 409, ya con la cifra de ahora: el mismo código vale.
    const fixed = { ...dto, items: dto.items.map((it, i) => (i === 0 ? { ...it, expectedTotalCents: 1 } : it)) };
    await expect(s.pay(fixed, { key: `${KEY}-b` })).resolves.toMatchObject({ paidCount: 6 });
  });

  it('nada que pagarle (0 € o deuda): NOTHING_TO_PAY', async () => {
    const s = setup({ available: { [ids[0]!]: 0, [ids[1]!]: -500 } });
    const res = await failure(s.pay(body()));
    expect(res.body.problems).toEqual([
      { operatorId: ids[0], code: 'NOTHING_TO_PAY', totalCents: 0 },
      { operatorId: ids[1], code: 'NOTHING_TO_PAY', totalCents: -500 },
    ]);
    expect(s.operators.createPayout).not.toHaveBeenCalled();
  });

  it('en efectivo, sin cuenta, 48 h, titular, petición pendiente y de otro local: cada una su código y nadie cobra', async () => {
    const until = new Date(NOW.getTime() + 20 * 3600 * 1000);
    const s = setup({
      people: [
        person(0, { payoutMethod: 'MANUAL_CASH', payoutAddress: null }),
        person(1, { payoutAddress: null }),
        person(2, { payoutHoldUntil: until }),
        // Titular que no coincide con su nombre legal, sin confirmar (no se puede abrir: cuenta como sin confirmar).
        person(3, { legalName: 'pa1:no-se-abre', payoutMetadata: { accountHolder: 'pa1:tampoco' } }),
        person(4),
        person(5, { payoutMethod: null, payoutAddress: null }),
      ],
      pending: { [ids[4]!]: 9_000 },
    });
    const dto: CreatePayoutBatchDto = { items: [...items(), { operatorId: OTHER_VENUE, expectedTotalCents: 9_000 }], totpCode: code() };
    const res = await failure(s.pay(dto));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYOUT_BATCH_CHANGED');
    expect(res.body.problems).toEqual([
      { operatorId: ids[0], code: 'CASH' },
      { operatorId: ids[1], code: 'NO_ACCOUNT' },
      { operatorId: ids[2], code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: until.toISOString() },
      { operatorId: ids[3], code: 'PAYOUT_HOLDER_UNCONFIRMED' },
      { operatorId: ids[4], code: 'APPROVAL_ALREADY_PENDING' },
      { operatorId: ids[5], code: 'NO_ACCOUNT' },
      { operatorId: OTHER_VENUE, code: 'NOT_FOUND' },
    ]);
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.assertForUser).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(IBAN);
  });

  it('de otro local, dada de baja o que no existe: la misma respuesta, sin mirar su saldo', async () => {
    const s = setup({ people: [person(0)] });
    const ghost = '00000000-0000-4000-8000-00000000dead';
    const res = await failure(s.pay({ items: [{ operatorId: OTHER_VENUE, expectedTotalCents: 9_000 }, { operatorId: ghost, expectedTotalCents: 9_000 }], totpCode: code() }));
    expect(res.body.problems).toEqual([
      { operatorId: OTHER_VENUE, code: 'NOT_FOUND' },
      { operatorId: ghost, code: 'NOT_FOUND' },
    ]);
    expect(s.operators.getBalance).not.toHaveBeenCalled();
    // Se buscó solo en este local, entre quienes cobran y sin las dadas de baja.
    expect(s.tx.user.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: TENANT, deletedAt: null, role: { in: ['OPERATOR', 'WAITER'] } });
  });
});

describe('«Pagar» a varias a la vez — fallos dentro de la tanda', () => {
  it('un 409 en la tercera: cinco pagadas y esa FAILED con PAYOUT_CHANGED y la cifra de ahora', async () => {
    const s = setup();
    const real = s.operators.createPayout.getMockImplementation()!;
    s.operators.createPayout.mockImplementation(async (...args) => {
      if (args[1] === ids[2]) throw payoutTotalChanged(12_500, 9_000);
      return real(...args);
    });
    const res = await s.pay(body());
    expect(res.results.map((r) => r.status)).toEqual(['PAID', 'PAID', 'FAILED', 'PAID', 'PAID', 'PAID']);
    expect(res.results[2]).toEqual({ operatorId: ids[2], status: 'FAILED', code: 'PAYOUT_CHANGED', totalCents: 12_500 });
    expect(res).toMatchObject({ paidCount: 5, paidCents: 45_000 });
    expect(s.operators.createPayout).toHaveBeenCalledTimes(6);
    expect(s.batchAudit()[0]!.payload).toMatchObject({
      paidCount: 5,
      paidCents: 45_000,
      results: expect.arrayContaining([{ operatorId: ids[2], status: 'FAILED', code: 'PAYOUT_CHANGED' }]),
    });
  });

  it('si pasó a efectivo (o se quedó sin cuenta) después de la comprobación: CASH / NO_ACCOUNT, con el candado tomado', async () => {
    const s = setup();
    s.operators.createPayout.mockImplementationOnce(async (_t, operatorId, _by, _n, options) => {
      // Entre la comprobación en seco y su turno, Lucía cambió a efectivo.
      s.people.set(operatorId, person(0, { payoutMethod: 'MANUAL_CASH', payoutAddress: null }));
      await options.inTransaction(s.tx);
      throw new Error('no debió llegar a pagar');
    });
    s.operators.createPayout.mockImplementationOnce(async (_t, operatorId, _by, _n, options) => {
      s.people.set(operatorId, person(1, { payoutAddress: '  ' }));
      await options.inTransaction(s.tx);
      throw new Error('no debió llegar a pagar');
    });
    const res = await s.pay(body());
    expect(res.results.slice(0, 2)).toEqual([
      { operatorId: ids[0], status: 'FAILED', code: 'CASH' },
      { operatorId: ids[1], status: 'FAILED', code: 'NO_ACCOUNT' },
    ]);
    expect(res).toMatchObject({ paidCount: 4, paidCents: 36_000 });
  });

  it('dentro de la transacción se vuelve a mirar: petición pendiente, 48 h, titular y baja', async () => {
    const until = new Date(NOW.getTime() + 3600 * 1000);
    const s = setup();
    const real = s.operators.createPayout.getMockImplementation()!;
    s.operators.createPayout.mockImplementation(async (...args) => {
      const id = args[1];
      if (id === ids[0]) s.pending.set(id, 9_000);
      if (id === ids[1]) s.people.set(id, person(1, { payoutHoldUntil: until }));
      if (id === ids[2]) s.people.set(id, person(2, { legalName: 'pa1:no-se-abre', payoutMetadata: { accountHolder: 'pa1:tampoco' } }));
      if (id === ids[3]) s.people.delete(id);
      return real(...args);
    });
    const res = await s.pay(body());
    expect(res.results).toEqual([
      { operatorId: ids[0], status: 'FAILED', code: 'APPROVAL_ALREADY_PENDING' },
      { operatorId: ids[1], status: 'FAILED', code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: until.toISOString() },
      { operatorId: ids[2], status: 'FAILED', code: 'PAYOUT_HOLDER_UNCONFIRMED' },
      { operatorId: ids[3], status: 'FAILED', code: 'NOT_FOUND' },
      { operatorId: ids[4], status: 'PAID', payoutId: payoutIdOf(ids[4]!), totalCents: 9_000 },
      { operatorId: ids[5], status: 'PAID', payoutId: payoutIdOf(ids[5]!), totalCents: 9_000 },
    ]);
  });

  it('un 404 → NOT_FOUND; un 409 sin código → NOTHING_TO_PAY; otro 409 → OTHER; y sigue con las demás', async () => {
    const s = setup();
    const real = s.operators.createPayout.getMockImplementation()!;
    s.operators.createPayout.mockImplementation(async (...args) => {
      if (args[1] === ids[0]) throw new NotFoundException('Operadora no encontrada');
      if (args[1] === ids[1]) throw new ConflictException('Saldo neto 0 € — no hay nada que liquidar');
      if (args[1] === ids[2]) throw new ConflictException({ message: 'Ese hash ya es de otro pago', code: 'PAYOUT_TX_ALREADY_USED' });
      return real(...args);
    });
    const res = await s.pay(body());
    expect(res.results.slice(0, 3)).toEqual([
      { operatorId: ids[0], status: 'FAILED', code: 'NOT_FOUND' },
      { operatorId: ids[1], status: 'FAILED', code: 'NOTHING_TO_PAY' },
      { operatorId: ids[2], status: 'FAILED', code: 'OTHER' },
    ]);
    expect(res.paidCount).toBe(3);
  });

  it('un error inesperado en la tercera: dos pagadas, esa UNKNOWN y las tres siguientes SKIPPED (no se intentan)', async () => {
    for (const boom of [new Error('connection terminated'), new ServiceUnavailableException('base caída')]) {
      const s = setup();
      const real = s.operators.createPayout.getMockImplementation()!;
      s.operators.createPayout.mockImplementation(async (...args) => {
        if (args[1] === ids[2]) throw boom;
        return real(...args);
      });
      const res = await s.pay(body());
      expect(res.results).toEqual([
        { operatorId: ids[0], status: 'PAID', payoutId: payoutIdOf(ids[0]!), totalCents: 9_000 },
        { operatorId: ids[1], status: 'PAID', payoutId: payoutIdOf(ids[1]!), totalCents: 9_000 },
        { operatorId: ids[2], status: 'FAILED', code: 'UNKNOWN' },
        { operatorId: ids[3], status: 'SKIPPED', code: 'SKIPPED' },
        { operatorId: ids[4], status: 'SKIPPED', code: 'SKIPPED' },
        { operatorId: ids[5], status: 'SKIPPED', code: 'SKIPPED' },
      ]);
      expect(res).toMatchObject({ paidCount: 2, paidCents: 18_000 });
      expect(s.operators.createPayout).toHaveBeenCalledTimes(3);
      expect(s.batchAudit()).toHaveLength(1);
      expect(s.batchAudit()[0]!.payload).toMatchObject({ paidCount: 2, paidCents: 18_000 });
      expect(JSON.stringify(res)).not.toContain('connection');
    }
  });
});

describe('«Pagar» a varias a la vez — la misma clave otra vez', () => {
  const recorded = Object.fromEntries(ids.map((id) => [id, 9_000]));

  it('ya apuntada: los mismos pagos, sin 2FA (ni código), sin pagar y sin registro', async () => {
    const s = setup({ recorded });
    const res = await s.pay({ items: items() });
    expect(res).toEqual({
      results: ids.map((operatorId) => ({ operatorId, status: 'PAID', payoutId: payoutIdOf(operatorId), totalCents: 9_000 })),
      paidCount: 6,
      paidCents: 54_000,
    });
    expect(s.assertForUser).not.toHaveBeenCalled();
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
    expect(s.prisma.withTenant).not.toHaveBeenCalled();
    expect(s.operators.findPayoutReplay).toHaveBeenCalledWith(TENANT, ids[0], OWNER, { key: `${KEY}:${ids[0]}`, hash: s.hashOf(ids[0]!, 9_000) });
  });

  it('con otro cuerpo (otra cifra): 409 IDEMPOTENCY_KEY_REUSED, sin gastar el código y sin pagar a nadie', async () => {
    const s = setup({ recorded });
    const dto = { items: items().map((it, i) => (i === 5 ? { ...it, expectedTotalCents: 8_000 } : it)), totpCode: code() };
    expect(await failure(s.pay(dto))).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(s.assertForUser).not.toHaveBeenCalled();
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it('a medias (se cortó tras la segunda): las dos de antes vuelven PAID sin tocarlas y se paga solo a las otras, con el 2FA de toda la tanda', async () => {
    const s = setup({ recorded: { [ids[0]!]: 9_000, [ids[1]!]: 9_000 } });
    const res = await s.pay(body());
    expect(res).toMatchObject({ paidCount: 6, paidCents: 54_000 });
    expect(s.operators.createPayout.mock.calls.map((c) => c[1])).toEqual(ids.slice(2));
    expect(s.operators.getBalance.mock.calls.map((c) => c[0])).toEqual(ids.slice(2));
    expect(s.assertForUser).toHaveBeenCalledWith(OWNER, expect.any(String), stepUpActions.payoutBatch(KEY, 6, 54_000), PAYOUT_BATCH_2FA_MESSAGE);
    expect(s.batchAudit()[0]!.payload).toMatchObject({
      paidCount: 6,
      results: expect.arrayContaining([{ operatorId: ids[0], status: 'PAID', payoutId: payoutIdOf(ids[0]!), replayed: true }]),
    });
  });
});

describe('«Pagar» a varias a la vez — quién', () => {
  it('el encargado que tiene que pedírselo al dueño: 409 y no se pide ni se paga nada', async () => {
    const s = setup({ role: 'MANAGER', payoutRequiresApproval: true });
    expect(await failure(s.pay(body()))).toEqual({
      status: 409,
      body: {
        code: 'PAYOUT_BATCH_NEEDS_APPROVAL',
        message: 'En este local los pagos del encargado los aprueba el dueño: pídelos uno a uno.',
      },
    });
    expect(s.approvals.requestPayout).not.toHaveBeenCalled();
    expect(s.operators.findPayoutReplay).not.toHaveBeenCalled();
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.assertForUser).not.toHaveBeenCalled();
  });

  it('el encargado que paga directo: con su 2FA, como el dueño', async () => {
    const s = setup({ role: 'MANAGER' });
    await expect(s.pay(body())).resolves.toMatchObject({ paidCount: 6 });
    expect(s.assertForUser).toHaveBeenCalledTimes(1);
  });

  it('un camarero (u otro rol): 403 antes de mirar nada', async () => {
    for (const role of ['WAITER', 'OPERATOR'] as const) {
      const s = setup({ role });
      expect((await failure(s.pay(body()))).status).toBe(403);
      expect(s.operators.findPayoutReplay).not.toHaveBeenCalled();
      expect(s.operators.createPayout).not.toHaveBeenCalled();
    }
  });
});

describe('«Pagar» a varias a la vez — el segundo factor', () => {
  it('sin 2FA y sin llave: 403 con el texto de la tanda y nadie cobra (también el dueño que paga una a una sin código)', async () => {
    const s = setup({ secret: null });
    expect(await failure(s.pay({ items: items() }))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'TOTP_NOT_ENROLLED', message: PAYOUT_BATCH_2FA_MESSAGE }),
    });
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it('con 2FA: sin código o con uno malo, 403 y nadie cobra', async () => {
    const s = setup();
    expect(await failure(s.pay({ items: items() }))).toMatchObject({ status: 403, body: { code: 'TOTP_REQUIRED' } });
    expect(await failure(s.pay({ items: items(), totpCode: '000000' }))).toMatchObject({ status: 403, body: { code: 'TOTP_INVALID' } });
    expect(s.operators.createPayout).not.toHaveBeenCalled();
  });

  it('un código vale una vez: el de una tanda no paga otra', async () => {
    const s = setup();
    const dto = body(3);
    await expect(s.pay(dto)).resolves.toMatchObject({ paidCount: 3 });
    const other = { items: items().slice(3), totpCode: dto.totpCode };
    expect(await failure(s.pay(other, { key: `${KEY}-2` }))).toMatchObject({ status: 403, body: { code: 'TOTP_INVALID' } });
    expect(s.operators.createPayout).toHaveBeenCalledTimes(3);
  });

  it('con llave de acceso y sin prueba: 403 PASSKEY_REQUIRED con la acción de ESTA tanda (clave, cuántas y total)', async () => {
    const s = setup({ secret: null, passkeys: 1 });
    expect(await failure(s.pay({ items: items() }))).toEqual({
      status: 403,
      body: { code: 'PASSKEY_REQUIRED', message: PAYOUT_BATCH_2FA_MESSAGE, stepUpAction: `payout-batch:${KEY}:6:54000` },
    });
    expect(s.operators.createPayout).not.toHaveBeenCalled();
  });

  it('con la prueba de la llave para ESTA tanda paga; la de otra clave, otra cantidad u otro total no vale', async () => {
    const s = setup({ secret: null, passkeys: 1 });
    const mint = (action: string) => s.tokens.mint({ userId: OWNER, sessionId: SID, action });
    for (const action of [
      stepUpActions.payoutBatch(`${KEY}-x`, 6, 54_000),
      stepUpActions.payoutBatch(KEY, 5, 54_000),
      stepUpActions.payoutBatch(KEY, 6, 45_000),
      stepUpActions.operatorPayout(ids[0]!),
    ]) {
      const wrong = await mint(action);
      expect(await failure(s.pay({ items: items() }, { proof: wrong.token }))).toMatchObject({ status: 403, body: { code: 'PASSKEY_REQUIRED' } });
    }
    expect(s.operators.createPayout).not.toHaveBeenCalled();
    const proof = await mint(stepUpActions.payoutBatch(KEY, 6, 54_000));
    await expect(s.pay({ items: items() }, { proof: proof.token })).resolves.toMatchObject({ paidCount: 6, paidCents: 54_000 });
    // La prueba vale una vez: otra tanda igual con otra clave no pasa con ella.
    expect(await failure(s.pay({ items: items() }, { key: `${KEY}-2`, proof: proof.token }))).toMatchObject({ status: 403 });
    expect(s.operators.createPayout).toHaveBeenCalledTimes(6);
  });
});
