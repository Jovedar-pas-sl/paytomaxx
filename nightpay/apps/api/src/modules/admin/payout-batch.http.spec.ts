import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { PayoutBatchResultSchema, stepUpActions } from '@nightpay/contracts';
import { EmailService } from '../../common/email/email.service';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IpRateLimitGuard } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { payoutRoute } from '../approvals/approval-rules';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { TotpService } from '../auth/totp.service';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { MetricsService } from '../metrics/metrics.service';
import { OperatorsService } from '../operators/operators.service';
import { PayoutBatchController } from './payout-batch.controller';
import { PayoutBatchService } from './payout-batch.service';

/**
 * Con la app Nest de verdad (Fastify, prefijo /v1, AuthGuard, RolesGuard,
 * permisos del personal y tope por persona) y el servicio de la tanda de
 * verdad: quién puede llamar a POST /v1/admin/payout-batches y qué cuerpo y
 * qué clave acepta. Lo de debajo (pagos, 2FA, base) es de mentira.
 */
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';
const KEY = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const URL = '/v1/admin/payout-batches';
const id = (n: number) => `a1c3e5f7-2b4d-4e6f-8a0b-${String(n).padStart(12, '0')}`;
const item = (n: number) => ({ operatorId: id(n), expectedTotalCents: 9_000 });

let payoutRequiresApproval = false;
/** Permisos del local (Ajustes → Permisos) que lee el guard: null = los de siempre. */
let staffPermissions: unknown = null;
const people = (wanted: string[]) =>
  wanted.map((userId) => ({
    id: userId,
    displayName: 'Lucía',
    payoutMethod: 'SEPA_IBAN',
    payoutAddress: 'ES9121000418450200051332',
    payoutHoldUntil: null,
    payoutMetadata: null,
    legalName: null,
    payoutHolderConfirmedAt: null,
  }));
const tx = {
  user: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => people(where.id.in)),
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => people([where.id])[0]),
  },
  approvalRequest: { findFirst: vi.fn(async () => null) },
};
const prisma = {
  asSystem: vi.fn(async (fn: (t: unknown) => unknown) => fn({ venue: { findUnique: vi.fn(async () => ({ staffPermissions })) } })),
  withTenant: vi.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
};
const operators = {
  findPayoutReplay: vi.fn(async () => null),
  getBalance: vi.fn(async () => ({ availableCents: 9_000 })),
  createPayout: vi.fn(async (_t: string, operatorId: string, _by: string, _n: undefined, o: { expectedTotalCents: number; inTransaction: (t: typeof tx) => Promise<void> }) => {
    await o.inTransaction(tx);
    return { id: operatorId.replace('a1c3e5f7', '9a8b7c6d'), totalCents: o.expectedTotalCents, earningCount: 1, createdAt: '2026-11-26T02:10:10.000Z' };
  }),
};
const approvals = {
  payoutRouteFor: vi.fn(async (actor: { role: 'OWNER' | 'MANAGER' }) =>
    payoutRoute(actor.role, { payoutRequiresApproval, refundApprovalThresholdCents: 10_000 }),
  ),
  requestPayout: vi.fn(),
};
const totp = { assertForUser: vi.fn(async () => undefined) };
const audit = { log: vi.fn(async () => undefined) };

let app: NestFastifyApplication;
let jwt: JwtService;

beforeAll(async () => {
  @Global()
  @Module({
    providers: [
      { provide: REDIS_CLIENT, useValue: createFakeRedis() },
      { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() } } },
      { provide: EmailService, useValue: { send: vi.fn() } },
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
    exports: [REDIS_CLIENT, MetricsService, EmailService, PrismaService, AuditService],
  })
  class FakeInfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: 'test_jwt_secret_0123456789abcdef0123456789' })],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      FakeInfraModule,
      AuthModule,
    ],
    controllers: [PayoutBatchController],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: OperatorsService, useValue: operators },
      { provide: ApprovalRequestsService, useValue: approvals },
      PayoutBatchService,
    ],
  })
    .overrideProvider(TotpService)
    .useValue(totp)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  jwt = app.get(JwtService, { strict: false });
});

afterAll(async () => {
  await app?.close();
});

let userSeq = 0;
/** Cada prueba, una persona nueva: el tope por persona no se arrastra de una a otra. */
let currentUser = USER;

beforeEach(() => {
  payoutRequiresApproval = false;
  staffPermissions = null;
  currentUser = `00000000-0000-4000-8000-${String(++userSeq).padStart(12, '0')}`;
  for (const fn of [operators.findPayoutReplay, operators.getBalance, operators.createPayout, totp.assertForUser, audit.log, approvals.requestPayout]) fn.mockClear();
  totp.assertForUser.mockReset().mockResolvedValue(undefined);
});

type RoleName = 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR';
function post(role: RoleName | null, body: unknown, key: string | null = KEY, extraHeaders: Record<string, string> = {}) {
  const token = role ? jwt.sign({ sub: currentUser, email: 'x@x.es', role, tenantId: TENANT, venueSlug: 'luna' }) : null;
  return app.inject({
    method: 'POST',
    url: URL,
    headers: {
      'cf-connecting-ip': '203.0.113.9',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...extraHeaders,
    },
    payload: body as object,
  });
}
const nothingPaid = () => {
  expect(operators.createPayout).not.toHaveBeenCalled();
  expect(totp.assertForUser).not.toHaveBeenCalled();
  expect(operators.findPayoutReplay).not.toHaveBeenCalled();
};

describe('POST /v1/admin/payout-batches — pagar a varias a la vez', () => {
  it('el dueño: 200 con una fila por persona; un solo 2FA, atado a la clave, a cuántas y al total', async () => {
    const res = await post('OWNER', { items: [item(1), item(2), item(3)], totpCode: '123456' });
    expect(res.statusCode).toBe(200);
    const body = PayoutBatchResultSchema.parse(res.json());
    expect(body).toMatchObject({ paidCount: 3, paidCents: 27_000 });
    expect(body.results.map((r) => [r.operatorId, r.status])).toEqual([[id(1), 'PAID'], [id(2), 'PAID'], [id(3), 'PAID']]);
    expect(totp.assertForUser).toHaveBeenCalledTimes(1);
    expect(totp.assertForUser).toHaveBeenCalledWith(currentUser, '123456', stepUpActions.payoutBatch(KEY, 3, 27_000), expect.stringContaining('Para pagar a varias a la vez'));
    expect(operators.createPayout).toHaveBeenCalledTimes(3);
    expect(operators.createPayout.mock.calls[0]!.slice(0, 3)).toEqual([TENANT, id(1), currentUser]);
    expect(res.body).not.toContain('ES91');
  });

  it('el encargado que paga directo (con el permiso de siempre): 200', async () => {
    const res = await post('MANAGER', { items: [item(1)], totpCode: '123456' });
    expect(res.statusCode).toBe(200);
    expect(operators.createPayout).toHaveBeenCalledTimes(1);
  });

  it('el encargado que tiene que pedirlo al dueño: 409 PAYOUT_BATCH_NEEDS_APPROVAL y no se pide ni se paga nada', async () => {
    payoutRequiresApproval = true;
    const res = await post('MANAGER', { items: [item(1), item(2)], totpCode: '123456' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'PAYOUT_BATCH_NEEDS_APPROVAL',
      detail: 'En este local los pagos del encargado los aprueba el dueño: pídelos uno a uno.',
    });
    expect(approvals.requestPayout).not.toHaveBeenCalled();
    nothingPaid();
  });

  it('el encargado sin el permiso «pagos»: 403 STAFF_PERMISSION_DENIED', async () => {
    staffPermissions = { roles: { MANAGER: { payouts: false } } };
    const res = await post('MANAGER', { items: [item(1)], totpCode: '123456' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STAFF_PERMISSION_DENIED', permission: 'payouts' });
    nothingPaid();
  });

  it('un camarero, una compañera o sin sesión: 403 / 401', async () => {
    expect((await post('WAITER', { items: [item(1)] })).statusCode).toBe(403);
    expect((await post('OPERATOR', { items: [item(1)] })).statusCode).toBe(403);
    expect((await post(null, { items: [item(1)] })).statusCode).toBe(401);
    nothingPaid();
  });

  it('sin 2FA ni llave (o con un código usado): el 403 del segundo factor y nadie cobra', async () => {
    totp.assertForUser.mockRejectedValueOnce(new ForbiddenException({ message: 'Código 2FA incorrecto', code: 'TOTP_INVALID' }));
    const res = await post('OWNER', { items: [item(1), item(2)], totpCode: '123456' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TOTP_INVALID' });
    expect(operators.createPayout).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('POST /v1/admin/payout-batches — cuerpo y clave (400)', () => {
  it('más de 50, ids repetidos, vacío o campos de más (importe, método, cuenta, notas): 400', async () => {
    const bodies: unknown[] = [
      { items: Array.from({ length: 51 }, (_, i) => item(i + 1)) },
      { items: [item(1), item(1)] },
      { items: [] },
      {},
      { items: [{ ...item(1), amountCents: 5 }] },
      { items: [{ ...item(1), externalRail: 'MANUAL_CASH' }] },
      { items: [{ ...item(1), payoutAddress: 'ES9121000418450200051332' }] },
      { items: [item(1)], notes: 'cierre' },
      { items: [{ operatorId: 'lucia', expectedTotalCents: 9_000 }] },
      { items: [{ operatorId: id(1), expectedTotalCents: 0 }] },
    ];
    for (const body of bodies) {
      const res = await post('OWNER', body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    nothingPaid();
  });

  it('50 justas: vale', async () => {
    const res = await post('OWNER', { items: Array.from({ length: 50 }, (_, i) => item(i + 1)), totpCode: '123456' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paidCount: 50, paidCents: 450_000 });
  });

  it('sin clave, con «_», con otros signos, corta o de más de 64: 400', async () => {
    for (const key of [null, 'tanda_2026_11_26', 'tanda:2026:11', 'corta', 'k'.repeat(65)]) {
      const res = await post('OWNER', { items: [item(1)], totpCode: '123456' }, key);
      expect(res.statusCode, String(key)).toBe(400);
    }
    nothingPaid();
    expect((await post('OWNER', { items: [item(1)], totpCode: '123456' }, 'k'.repeat(64))).statusCode).toBe(200);
  });
});

describe('POST /v1/admin/payout-batches — tope por persona', () => {
  it('diez por minuto; la undécima, 429', async () => {
    for (let i = 0; i < 10; i += 1) expect((await post('OWNER', { items: [item(1)], totpCode: '123456' }, `${KEY}-${i}`)).statusCode).toBe(200);
    expect((await post('OWNER', { items: [item(1)], totpCode: '123456' }, `${KEY}-11`)).statusCode).toBe(429);
  });
});
