import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { AdminController, quarterRange } from './admin.controller';
import { payoutRoute, type VenueApprovalRules } from '../approvals/approval-rules';
import { sealTotpSecret } from '../auth/totp-crypto';
import { createFakeRedis, type FakeRedis } from '../auth/testing/fake-redis';
import { makeTotpKit, totpCodeAt } from '../auth/testing/totp-kit';

describe('quarterRange', () => {
  it('Q1-2026 → 1-ene-2026 a 1-abr-2026 (00:00 de Madrid; abril ya en verano)', () => {
    const r = quarterRange('Q1-2026');
    expect(r.label).toBe('Q1-2026');
    expect(r.from.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('Q2-2026 → 1-abr a 1-jul', () => {
    const r = quarterRange('Q2-2026');
    expect(r.from.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });

  it('Q3-2026 → 1-jul a 1-oct', () => {
    const r = quarterRange('Q3-2026');
    expect(r.from.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-30T22:00:00.000Z');
  });

  it('Q4-2025 cruza año → 1-oct-2025 a 1-ene-2026', () => {
    const r = quarterRange('Q4-2025');
    expect(r.from.toISOString()).toBe('2025-09-30T22:00:00.000Z');
    expect(r.to.toISOString()).toBe('2025-12-31T23:00:00.000Z');
  });

  it('undefined → trimestre actual según el día de Madrid', () => {
    const r = quarterRange(undefined);
    expect(r.label).toMatch(/^Q[1-4]-\d{4}$/);
    // El intervalo debe ser de 3 meses exactos
    const diffMonths =
      (r.to.getUTCFullYear() - r.from.getUTCFullYear()) * 12 +
      (r.to.getUTCMonth() - r.from.getUTCMonth());
    expect(diffMonths).toBe(3);
  });

  it('formato inválido lanza Error', () => {
    expect(() => quarterRange('Q5-2026')).toThrow();
    expect(() => quarterRange('Q1-26')).toThrow();
    expect(() => quarterRange('2026-Q1')).toThrow();
    // Nota: '' es falsy → quarterRange lo trata como "current quarter", no throw.
    // El validator zod regex bloquea '' antes de llegar a la función en producción.
  });
});

describe('POST /admin/operators/:id/payouts — 2FA del que paga (Redis, vale con varias réplicas)', () => {
  const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const OWNER = 'own-1';
  const owner = { sub: OWNER, tenantId: 't-1', role: 'OWNER' } as unknown as JwtPayload;
  let previousKek: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T22:00:10Z'));
    previousKek = process.env.ENCRYPTION_KEK;
    process.env.ENCRYPTION_KEK = KEK;
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.ENCRYPTION_KEK = previousKek;
  });

  function controller(
    totpSecret: string | null,
    redis: FakeRedis = createFakeRedis(),
    who: JwtPayload = owner,
    rules: VenueApprovalRules = { payoutRequiresApproval: true, refundApprovalThresholdCents: 10_000 },
  ) {
    const { totp } = makeTotpKit({ redis, users: { [who.sub]: totpSecret } });
    const operators = { createPayout: vi.fn().mockResolvedValue({ id: 'po-1' }) };
    const approvals = {
      payoutRouteFor: vi.fn(async (actor: { role: JwtPayload['role'] }) => payoutRoute(actor.role, rules)),
      requestPayout: vi.fn().mockResolvedValue({ approvalRequestId: 'ap-1', status: 'PENDING' }),
    };
    const none = {} as never;
    const ctrl = new AdminController(none, none, none, operators as never, none, none, totp, approvals as never);
    const reply = { status: vi.fn() };
    const pay = (totpCode?: string) =>
      ctrl.createOperatorPayout('t-1', who, 'op-1', { notes: 'semana', ...(totpCode ? { totpCode } : {}) }, reply as never);
    return { pay, operators, approvals, reply };
  }

  async function failureOf(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
    return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
  }

  it('sin 2FA activada: paga sin pedir código (como antes)', async () => {
    const { pay, operators } = controller(null);
    await expect(pay()).resolves.toEqual({ id: 'po-1' });
    expect(operators.createPayout).toHaveBeenCalledWith('t-1', 'op-1', OWNER, 'semana', expect.any(Object));
  });

  it('con 2FA: sin código → 403 TOTP_REQUIRED y no se paga', async () => {
    const { pay, operators } = controller(sealTotpSecret(SECRET, KEK));
    expect(await failureOf(pay())).toEqual({ status: 403, body: expect.objectContaining({ code: 'TOTP_REQUIRED' }) });
    expect(operators.createPayout).not.toHaveBeenCalled();
  });

  it('con 2FA: código malo → TOTP_INVALID; el bueno paga; repetido → TOTP_INVALID', async () => {
    const { pay, operators } = controller(sealTotpSecret(SECRET, KEK));
    expect(await failureOf(pay('000000'))).toEqual({ status: 403, body: expect.objectContaining({ code: 'TOTP_INVALID' }) });
    const code = totpCodeAt(SECRET);
    await expect(pay(code)).resolves.toEqual({ id: 'po-1' });
    const reused = await failureOf(pay(code));
    expect(reused.body).toMatchObject({ code: 'TOTP_INVALID' });
    expect(String(reused.body.message)).toMatch(/cambia cada 30 s/);
    expect(operators.createPayout).toHaveBeenCalledTimes(1);
  });

  it('el pago directo comprueba dentro de la transacción que no haya un pago pedido para la chica', async () => {
    const { pay, operators } = controller(null);
    await pay();
    const options = operators.createPayout.mock.calls[0]![4] as { inTransaction?: unknown };
    expect(typeof options.inTransaction).toBe('function');
  });

  it('encargado con aprobación del local: no paga, lo pide (202) y sin pedirle código', async () => {
    const manager = { sub: 'man-1', tenantId: 't-1', role: 'MANAGER' } as unknown as JwtPayload;
    const { pay, operators, approvals, reply } = controller(null, createFakeRedis(), manager);
    await expect(pay()).resolves.toEqual({ approvalRequestId: 'ap-1', status: 'PENDING' });
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(approvals.requestPayout).toHaveBeenCalledWith(
      { userId: 'man-1', role: 'MANAGER', tenantId: 't-1' },
      'op-1',
      expect.objectContaining({ notes: 'semana' }),
    );
    expect(operators.createPayout).not.toHaveBeenCalled();
  });

  it('encargado sin aprobación del local: paga él, con 2FA obligatoria', async () => {
    const manager = { sub: 'man-1', tenantId: 't-1', role: 'MANAGER' } as unknown as JwtPayload;
    const direct = { payoutRequiresApproval: false, refundApprovalThresholdCents: 10_000 };
    const without = controller(null, createFakeRedis(), manager, direct);
    expect(await failureOf(without.pay())).toEqual({ status: 403, body: expect.objectContaining({ code: 'TOTP_NOT_ENROLLED' }) });
    expect(without.operators.createPayout).not.toHaveBeenCalled();

    const enrolled = controller(sealTotpSecret(SECRET, KEK), createFakeRedis(), manager, direct);
    expect(await failureOf(enrolled.pay())).toEqual({ status: 403, body: expect.objectContaining({ code: 'TOTP_REQUIRED' }) });
    await expect(enrolled.pay(totpCodeAt(SECRET))).resolves.toEqual({ id: 'po-1' });
    expect(enrolled.reply.status).not.toHaveBeenCalled();
    expect(enrolled.approvals.requestPayout).not.toHaveBeenCalled();
  });

  it('dos réplicas con el mismo Redis: el código usado en una no paga en la otra', async () => {
    const redis = createFakeRedis();
    const a = controller(sealTotpSecret(SECRET, KEK), redis);
    const b = controller(sealTotpSecret(SECRET, KEK), redis);
    const code = totpCodeAt(SECRET);
    await a.pay(code);
    expect((await failureOf(b.pay(code))).body).toMatchObject({ code: 'TOTP_INVALID' });
    expect(b.operators.createPayout).not.toHaveBeenCalled();
  });
});

describe('PATCH /admin/operators/:id — cambiar la cuenta de cobro pide 2FA', () => {
  const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const owner = { sub: 'own-1', tenantId: 't-1', role: 'OWNER' } as unknown as JwtPayload;
  let previousKek: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T22:00:10Z'));
    previousKek = process.env.ENCRYPTION_KEK;
    process.env.ENCRYPTION_KEK = KEK;
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.ENCRYPTION_KEK = previousKek;
  });

  function controller(totpSecret: string | null, who: JwtPayload = owner) {
    const { totp } = makeTotpKit({ users: { [who.sub]: totpSecret } });
    const operators = { updateOperator: vi.fn().mockResolvedValue({ id: 'op-1' }) };
    const none = {} as never;
    const ctrl = new AdminController(none, none, none, operators as never, none, none, totp, none);
    const update = (dto: Record<string, unknown>) => ctrl.updateOperator('t-1', who, 'op-1', dto as never);
    return { update, operators };
  }

  it('dueño con 2FA: sin código → 403 TOTP_REQUIRED y no se cambia nada', async () => {
    const { update, operators } = controller(sealTotpSecret(SECRET, KEK));
    for (const dto of [{ payoutAddress: 'ES9121000418450200051332' }, { payoutMethod: 'CASH' }, { payoutLabel: 'x' }]) {
      const err = await update(dto).catch((e: unknown) => e);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    }
    expect(operators.updateOperator).not.toHaveBeenCalled();
  });

  it('dueño con 2FA: con el código bueno se cambia', async () => {
    const { update, operators } = controller(sealTotpSecret(SECRET, KEK));
    await expect(update({ payoutMethod: 'CASH', totpCode: totpCodeAt(SECRET) })).resolves.toEqual({ id: 'op-1' });
    expect(operators.updateOperator).toHaveBeenCalledOnce();
  });

  it('lo que no es la cuenta de cobro (nombre, comisión…) no pide código', async () => {
    const { update, operators } = controller(sealTotpSecret(SECRET, KEK));
    await update({ displayName: 'Ana', commissionBps: 8500 });
    expect(operators.updateOperator).toHaveBeenCalledOnce();
  });

  it('dueño sin 2FA activada: se cambia como antes', async () => {
    const { update, operators } = controller(null);
    await update({ payoutMethod: 'CASH' });
    expect(operators.updateOperator).toHaveBeenCalledOnce();
  });
});

describe('PATCH /admin/venue/settings — comisiones del local', () => {
  const owner = { sub: 'own-1', tenantId: 't-1', role: 'OWNER' } as unknown as JwtPayload;
  const stored = {
    operatorMaxCobroCents: 20_000,
    platformCommissionBps: 1000,
    operatorCommissionDefaults: { CHICA_SERVICE: 9000, VENUE_BAR: 0 },
    payoutHoldDays: null,
    refundApprovalThresholdCents: 10_000,
    payoutRequiresApproval: false,
  };

  function controller(maxOverrideBps: number | null = null) {
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't-1', ...stored, ...data }));
    const tx = {
      venue: { findUniqueOrThrow: vi.fn().mockResolvedValue(stored), update },
      user: { aggregate: vi.fn().mockResolvedValue({ _max: { commissionBps: maxOverrideBps } }) },
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const none = {} as never;
    const ctrl = new AdminController(prisma as never, none, audit as never, none, none, none, none, none);
    const save = (dto: Record<string, unknown>) => ctrl.updateVenueSettings('t-1', owner, dto as never);
    return { save, update, audit };
  }

  async function statusOf(promise: Promise<unknown>): Promise<number | null> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    return err instanceof HttpException ? err.getStatus() : null;
  }

  it('la comisión de la plataforma no la cambia el dueño (403); la misma de siempre se ignora', async () => {
    const { save, update } = controller();
    expect(await statusOf(save({ platformCommissionBps: 0 }))).toBe(403);
    expect(update).not.toHaveBeenCalled();
    await save({ platformCommissionBps: 1000, operatorMaxCobroCents: 30_000 });
    expect(update.mock.calls[0]![0].data).toEqual({ operatorMaxCobroCents: 30_000 });
  });

  it('chica + plataforma > 100 % en una categoría → 400 y no se guarda', async () => {
    const { save, update } = controller();
    expect(await statusOf(save({ operatorCommissionDefaults: { CHICA_SERVICE: 9500 } }))).toBe(400);
    expect(await statusOf(save({ operatorCommissionDefaults: { VENUE_BAR: 9001 } }))).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('comisiones parciales: se mezclan con las guardadas (y las que faltan, por defecto) y se apuntan', async () => {
    const { save, update, audit } = controller();
    await save({ operatorCommissionDefaults: { VENUE_BAR: 500 } });
    expect(update.mock.calls[0]![0].data).toEqual({
      operatorCommissionDefaults: expect.objectContaining({ CHICA_SERVICE: 9000, VENUE_BAR: 500 }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'venue.settings.updated',
        payload: { changes: { operatorCommissionDefaults: { VENUE_BAR: 500 } } },
      }),
    );
  });

  it('una chica con un % propio que ya no cuadra con la plataforma → 400 (como en la consola)', async () => {
    const { save } = controller(9500);
    expect(await statusOf(save({ operatorMaxCobroCents: 30_000 }))).toBe(400);
  });
});
