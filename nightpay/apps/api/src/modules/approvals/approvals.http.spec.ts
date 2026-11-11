import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { APPROVAL_REQUESTED_MESSAGE, ApprovalRequestedResponseSchema } from '@nightpay/contracts';
import { EmailService } from '../../common/email/email.service';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IpRateLimitGuard } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { MetricsService } from '../metrics/metrics.service';
import { RefundsController } from '../refunds/refunds.controller';
import { RefundsService } from '../refunds/refunds.service';
import { ApprovalRequestsService } from './approval-requests.service';
import { refundNeedsApproval, refundRoute } from './approval-rules';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * Con la app Nest de verdad (Fastify, prefijo /v1, AuthGuard y RolesGuard):
 * el contrato 202 del endpoint de siempre cuando el encargado pide al dueño,
 * y quién puede llamar a /v1/approvals. Los servicios son de mentira.
 */
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const PAYMENT = '00000000-0000-4000-8000-0000000000cc';
const APPROVAL = '00000000-0000-4000-8000-0000000000dd';
const USER = '00000000-0000-4000-8000-000000000001';
const venue = { name: 'Luna', payoutRequiresApproval: true, refundApprovalThresholdCents: 10_000 };

const refunds = { refund: vi.fn(), replay: vi.fn(async () => null) };
/** Permisos del local (Ajustes → Permisos) que lee el guard: null = los de siempre. */
let staffPermissions: unknown = null;
const prisma = {
  asSystem: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ venue: { findUnique: vi.fn(async () => ({ staffPermissions })) } }),
  ),
};
const requests = {
  replayRefund: vi.fn(async () => null),
  refundRouteFor: vi.fn(async (actor: { role: 'OWNER' | 'MANAGER' }, cents: number, _payment: string) =>
    refundRoute(actor.role, cents, venue),
  ),
  requestRefund: vi.fn(),
  list: vi.fn(),
  rules: vi.fn(),
  reject: vi.fn(),
};
const approvals = { approve: vi.fn() };

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
      { provide: AuditService, useValue: { log: vi.fn() } },
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
    controllers: [RefundsController, ApprovalsController],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: RefundsService, useValue: refunds },
      { provide: ApprovalRequestsService, useValue: requests },
      { provide: ApprovalsService, useValue: approvals },
    ],
  }).compile();

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

beforeEach(() => {
  refunds.replay.mockReset().mockResolvedValue(null);
  requests.replayRefund.mockReset().mockResolvedValue(null);
  staffPermissions = null;
  refunds.refund.mockReset().mockResolvedValue({ id: 'rf-1', status: 'SUCCEEDED', amountCents: 5_000 });
  requests.requestRefund.mockReset().mockResolvedValue({
    approvalRequestId: APPROVAL,
    status: 'PENDING',
    kind: 'REFUND',
    amountCents: 15_000,
    message: APPROVAL_REQUESTED_MESSAGE,
  });
  approvals.approve.mockReset().mockResolvedValue({ id: APPROVAL, status: 'APPROVED' });
  requests.reject.mockReset().mockResolvedValue({ id: APPROVAL, status: 'REJECTED' });
  requests.list.mockReset().mockResolvedValue({ items: [] });
});

function call(method: 'GET' | 'POST', url: string, role: 'OWNER' | 'MANAGER' | 'WAITER', body?: unknown) {
  const token = jwt.sign({ sub: USER, email: 'x@x.es', role, tenantId: TENANT, venueSlug: 'luna' });
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '203.0.113.9' },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

describe('POST /v1/payments/:id/refunds — el encargado desde el umbral pide (202)', () => {
  it('pasa la clave original a la devolución y al replay antes de consultar la ruta', async () => {
    const body = { amountCents: 5000, reason: 'queja', idempotencyKey: 'refund-http-intention' };
    const res = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'OWNER', body);
    expect(res.statusCode).toBe(201);
    expect(refunds.refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: body.idempotencyKey }), expect.anything());
    refunds.replay.mockResolvedValueOnce({ id: 'rf-1', status: 'SUCCEEDED', amountCents: 5000 } as never);
    refunds.refund.mockClear();
    const replay = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'OWNER', body);
    expect(replay.statusCode).toBe(201);
    expect(refunds.refund).not.toHaveBeenCalled();
  });
  it('encargado, 150 € (≥ 100 €): 202 con { approvalRequestId, status: PENDING, mensaje } y no se devuelve nada', async () => {
    const res = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 15_000, reason: 'queja' });
    expect(res.statusCode).toBe(202);
    const body = ApprovalRequestedResponseSchema.parse(res.json());
    expect(body).toMatchObject({ approvalRequestId: APPROVAL, status: 'PENDING', message: 'Pedido al dueño. Te avisamos cuando lo apruebe.' });
    expect(requests.requestRefund).toHaveBeenCalledWith(
      { userId: USER, role: 'MANAGER', tenantId: TENANT },
      { paymentId: PAYMENT, amountCents: 15_000, reason: 'queja' },
    );
    expect(refunds.refund).not.toHaveBeenCalled();
    // Lo que ya devolvió en ese cobro cuenta: se le pasa el cobro.
    expect(requests.refundRouteFor).toHaveBeenCalledWith(expect.objectContaining({ role: 'MANAGER' }), 15_000, PAYMENT);
  });

  it('encargado por debajo del umbral, o el dueño: se hace como siempre (201)', async () => {
    const below = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 9_999 });
    expect(below.statusCode).toBe(201);
    expect(below.json()).toMatchObject({ status: 'SUCCEEDED' });
    const own = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'OWNER', { amountCents: 50_000, totpCode: '123456' });
    expect(own.statusCode).toBe(201);
    expect(refunds.refund).toHaveBeenCalledTimes(2);
    expect(requests.requestRefund).not.toHaveBeenCalled();
  });
});

describe('POST /v1/payments/:id/refunds — permisos del personal (Ajustes)', () => {
  it('el dueño le quitó «devolver» al encargado: 403 STAFF_PERMISSION_DENIED y no se pide ni se devuelve nada', async () => {
    staffPermissions = { roles: { MANAGER: { refund: false } } };
    const res = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 5_000 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STAFF_PERMISSION_DENIED', permission: 'refund' });
    expect(res.json().detail).toMatch(/no te deja hacer devoluciones/);
    expect(refunds.refund).not.toHaveBeenCalled();
    expect(requests.requestRefund).not.toHaveBeenCalled();
  });

  it('una excepción para esa persona manda sobre su rol; el dueño puede siempre', async () => {
    staffPermissions = { roles: { MANAGER: { refund: false } }, people: { [USER]: { refund: true } } };
    expect((await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 5_000 })).statusCode).toBe(201);
    staffPermissions = { roles: { MANAGER: { refund: false } } };
    expect((await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'OWNER', { amountCents: 5_000 })).statusCode).toBe(201);
  });
});

describe('POST /v1/payments/:id/refunds — a la vez otra devolución lo lleva al umbral', () => {
  it('la reserva (con el cobro bloqueado) dice REFUND_NEEDS_APPROVAL: no se devuelve nada y se pide al dueño (202)', async () => {
    refunds.refund.mockRejectedValueOnce(refundNeedsApproval(12_000, 10_000));
    const res = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 6_000, reason: 'queja' });
    expect(res.statusCode).toBe(202);
    expect(ApprovalRequestedResponseSchema.parse(res.json())).toMatchObject({ approvalRequestId: APPROVAL, status: 'PENDING' });
    expect(requests.requestRefund).toHaveBeenCalledWith(
      { userId: USER, role: 'MANAGER', tenantId: TENANT },
      { paymentId: PAYMENT, amountCents: 6_000, reason: 'queja' },
    );
  });

  it('otro 409 (no cabe…) sigue siendo un 409 y no se pide nada', async () => {
    refunds.refund.mockRejectedValueOnce(new ConflictException('Solo quedan 0 céntimos por devolver en este cobro'));
    const res = await call('POST', `/v1/payments/${PAYMENT}/refunds`, 'MANAGER', { amountCents: 6_000 });
    expect(res.statusCode).toBe(409);
    expect(requests.requestRefund).not.toHaveBeenCalled();
  });
});

describe('/v1/approvals', () => {
  it('listar: dueño y encargado (cada uno ve lo suyo en el servicio); el camarero no', async () => {
    expect((await call('GET', '/v1/approvals?status=PENDING', 'OWNER')).statusCode).toBe(200);
    expect(requests.list).toHaveBeenCalledWith(expect.objectContaining({ role: 'OWNER' }), { status: 'PENDING', limit: 50 });
    expect((await call('GET', '/v1/approvals', 'MANAGER')).statusCode).toBe(200);
    expect((await call('GET', '/v1/approvals', 'WAITER')).statusCode).toBe(403);
    expect((await call('GET', '/v1/approvals?status=RARO', 'OWNER')).statusCode).toBe(400);
  });

  it('aprobar: solo el dueño; el código, de 6 cifras (sin código: el dueño sin 2FA, con la prueba de su llave)', async () => {
    expect((await call('POST', `/v1/approvals/${APPROVAL}/approve`, 'MANAGER', { totpCode: '123456' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/approvals/${APPROVAL}/approve`, 'OWNER', { totpCode: '12345' })).statusCode).toBe(400);
    expect((await call('POST', `/v1/approvals/${APPROVAL}/approve`, 'OWNER', {})).statusCode).toBe(200);
    expect((await call('POST', '/v1/approvals/no-es-uuid/approve', 'OWNER', { totpCode: '123456' })).statusCode).toBe(400);
    const ok = await call('POST', `/v1/approvals/${APPROVAL}/approve`, 'OWNER', { totpCode: '123 456' });
    expect(ok.statusCode).toBe(200);
    expect(approvals.approve).toHaveBeenCalledWith({ userId: USER, role: 'OWNER', tenantId: TENANT }, APPROVAL, '123456');
  });

  it('rechazar: solo el dueño y siempre con el motivo', async () => {
    expect((await call('POST', `/v1/approvals/${APPROVAL}/reject`, 'OWNER', { note: ' ' })).statusCode).toBe(400);
    expect((await call('POST', `/v1/approvals/${APPROVAL}/reject`, 'MANAGER', { note: 'no' })).statusCode).toBe(403);
    const ok = await call('POST', `/v1/approvals/${APPROVAL}/reject`, 'OWNER', { note: 'ya se le pagó' });
    expect(ok.statusCode).toBe(200);
    expect(requests.reject).toHaveBeenCalledWith(expect.objectContaining({ role: 'OWNER' }), APPROVAL, 'ya se le pagó');
  });
});
