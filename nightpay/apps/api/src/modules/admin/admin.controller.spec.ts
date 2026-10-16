import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { AdminController, quarterRange } from './admin.controller';
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

  function controller(totpSecret: string | null, redis: FakeRedis = createFakeRedis()) {
    const { totp } = makeTotpKit({ redis, users: { [OWNER]: totpSecret } });
    const operators = { createPayout: vi.fn().mockResolvedValue({ id: 'po-1' }) };
    const none = {} as never;
    const ctrl = new AdminController(none, none, none, operators as never, none, none, totp);
    const pay = (totpCode?: string) =>
      ctrl.createOperatorPayout('t-1', owner, 'op-1', { notes: 'semana', ...(totpCode ? { totpCode } : {}) });
    return { pay, operators };
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
