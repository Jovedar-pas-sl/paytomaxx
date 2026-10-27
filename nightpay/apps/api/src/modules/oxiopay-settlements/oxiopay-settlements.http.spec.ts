import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Global, Module, NotFoundException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { emptyConceptAmounts, type SettlementDetail } from '@nightpay/contracts';
import { EmailService } from '../../common/email/email.service';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IpRateLimitGuard } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { CLAIM_STEP_LUA } from '../auth/totp-attempts.service';
import { claimStepScript, createFakeRedis } from '../auth/testing/fake-redis';
import { MetricsService } from '../metrics/metrics.service';
import { SuperAdminModule } from '../superadmin/superadmin.module';
import { OxioPaySettlementsModule } from './oxiopay-settlements.module';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';

/**
 * Permisos de la «Liquidación OxioPay» con la app Nest de verdad (Fastify,
 * /v1, AuthGuard, RolesGuard y SuperAdminGuard): el dueño ve las suyas (solo
 * lectura); encargado, camarero y chica, nada; la consola, solo el
 * super-admin, y sus escrituras con 2FA. El servicio y la base, de mentira.
 */
const SUPER = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const ID = '00000000-0000-4000-8000-0000000000cc';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const users = new Map<string, Record<string, unknown>>([
  [SUPER, { id: SUPER, email: 'jefe@x.es', isSuperAdmin: true, deletedAt: null, totpSecret: SECRET }],
  [OWNER, { id: OWNER, email: 'dueno@x.es', isSuperAdmin: false, deletedAt: null, totpSecret: null }],
]);
const tx = { user: { findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null } };
const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
const prisma = { acrossVenues: run, asSystem: run };
const audit = { log: vi.fn().mockResolvedValue(undefined) };

function detail(): SettlementDetail {
  return {
    id: ID,
    reference: 'OXP-2026-S44-LUNA',
    venue: { id: TENANT, name: 'Luna', slug: 'luna' },
    business: null,
    periodFrom: '2026-10-26T07:00:00.000Z',
    periodTo: '2026-11-02T07:00:00.000Z',
    isoYear: 2026,
    isoWeek: 44,
    status: 'ISSUED',
    periodCents: 2_235,
    adjustmentsCents: 0,
    totalCents: 2_235,
    paidCents: 0,
    pendingCents: 2_235,
    generatedAt: '2026-11-02T09:05:00.000Z',
    auto: true,
    overdue: false,
    daysOpen: 0,
    party: { venueName: 'Luna', venueSlug: 'luna', businessName: null, businessTaxId: null },
    nights: [],
    adjustments: [],
    byConcept: { ...emptyConceptAmounts(), serviceFeeSales: 2_235 },
    moneyMapCents: 2_235,
    payments: [],
    voidedAt: null,
    voidReason: null,
    replacesId: null,
    payee: null,
  };
}

const core = {
  listForOwner: vi.fn(async () => ({ items: [], payee: null, pendingCents: 0 })),
  noticeForOwner: vi.fn(async () => ({ overdue: [], overdueCents: 0 })),
  detailForOwner: vi.fn(async (tenantId: string) => {
    if (tenantId !== TENANT) throw new NotFoundException('Liquidación no encontrada');
    return detail();
  }),
  listForSuperAdmin: vi.fn(async () => ({ items: [], totals: { pendingCents: 0, pendingCount: 0, overdueCents: 0, overdueCount: 0 }, payeeMissing: true })),
  detailForSuperAdmin: vi.fn(async () => detail()),
  recordPayment: vi.fn(),
  voidSettlement: vi.fn(),
  generate: vi.fn(),
  payee: vi.fn(async () => null),
  setPayee: vi.fn(),
};

let app: NestFastifyApplication;
let jwt: JwtService;

beforeAll(async () => {
  process.env.ENCRYPTION_KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);

  @Global()
  @Module({
    providers: [
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() } } },
      { provide: EmailService, useValue: { send: vi.fn() } },
    ],
    exports: [REDIS_CLIENT, MetricsService, EmailService],
  })
  class FakeInfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: 'test_jwt_secret_0123456789abcdef0123456789', PAYOUT_HOLD_DAYS: 7 })],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      FakeInfraModule,
      AuthModule,
      OxioPaySettlementsModule,
      SuperAdminModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(AuditService)
    .useValue(audit)
    .overrideProvider(OxioPaySettlementsService)
    .useValue(core)
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

beforeEach(() => {
  vi.clearAllMocks();
});

async function as(sub: string, role: string, tenantId = TENANT): Promise<string> {
  const tokens = app.get(RefreshTokenService);
  const issued = await tokens.issue(sub, tenantId);
  await tokens.markTwoFactor(issued.family);
  return `Bearer ${jwt.sign({ sub, email: 'x@x.es', role, tenantId, venueSlug: 'luna', sid: issued.family })}`;
}

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, authorization?: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { ...(authorization ? { authorization } : {}), 'cf-connecting-ip': '203.0.113.9' },
    ...(body !== undefined ? { payload: body as object } : {}),
  });

describe('panel del dueño: /v1/admin/oxiopay-settlements (solo el dueño, solo lo suyo, solo lectura)', () => {
  it('sin sesión 401; encargado, camarero y chica 403 (ni la lista, ni la ficha, ni el documento)', async () => {
    expect((await call('GET', '/v1/admin/oxiopay-settlements')).statusCode).toBe(401);
    for (const role of ['MANAGER', 'WAITER', 'OPERATOR']) {
      const auth = await as(OWNER, role);
      for (const url of ['/v1/admin/oxiopay-settlements', '/v1/admin/oxiopay-settlements/notice', `/v1/admin/oxiopay-settlements/${ID}`, `/v1/admin/oxiopay-settlements/${ID}/document`, `/v1/admin/oxiopay-settlements/${ID}/csv`]) {
        expect((await call('GET', url, auth)).statusCode, `${role} ${url}`).toBe(403);
      }
    }
    expect(core.listForOwner).not.toHaveBeenCalled();
    expect(core.detailForOwner).not.toHaveBeenCalled();
  });

  it('el dueño: las de su local (el de la sesión), el documento HTML y el CSV', async () => {
    const auth = await as(OWNER, 'OWNER');
    expect((await call('GET', '/v1/admin/oxiopay-settlements', auth)).statusCode).toBe(200);
    expect(core.listForOwner).toHaveBeenCalledWith(TENANT);
    const doc = await call('GET', `/v1/admin/oxiopay-settlements/${ID}/document`, auth);
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-type']).toContain('text/html');
    expect(doc.body).toContain('OXP-2026-S44-LUNA');
    expect(doc.body).toContain('OxioPay aún no ha puesto la cuenta');
    const csv = await call('GET', `/v1/admin/oxiopay-settlements/${ID}/csv`, auth);
    expect(csv.headers['content-disposition']).toContain('liquidacion-oxiopay-OXP-2026-S44-LUNA.csv');
  });

  it('la de otro local: 404 (el servicio filtra por el local de la sesión)', async () => {
    const auth = await as(OWNER, 'OWNER', '00000000-0000-4000-8000-0000000000bb');
    expect((await call('GET', `/v1/admin/oxiopay-settlements/${ID}`, auth)).statusCode).toBe(404);
  });

  it('no hay ninguna escritura para el dueño', async () => {
    const auth = await as(OWNER, 'OWNER');
    expect((await call('POST', `/v1/admin/oxiopay-settlements/${ID}/payments`, auth, { amountCents: 1 })).statusCode).toBe(404);
  });
});

describe('consola: /v1/superadmin/oxiopay-settlements (solo el super-admin; escrituras con 2FA)', () => {
  it('un dueño que no es super-admin: 403 en todo', async () => {
    const auth = await as(OWNER, 'OWNER');
    expect((await call('GET', '/v1/superadmin/oxiopay-settlements', auth)).statusCode).toBe(403);
    expect((await call('POST', `/v1/superadmin/oxiopay-settlements/${ID}/void`, auth, { reason: 'mal', totpCode: '123456' })).statusCode).toBe(403);
    expect(core.listForSuperAdmin).not.toHaveBeenCalled();
  });

  it('super-admin: la lista con lo pendiente; la ficha y el documento', async () => {
    const auth = await as(SUPER, 'OWNER');
    const res = await call('GET', '/v1/superadmin/oxiopay-settlements?status=OPEN', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { pendingCents: 0 }, payeeMissing: true });
    expect(core.listForSuperAdmin).toHaveBeenCalledWith(expect.objectContaining({ status: 'OPEN' }), expect.any(Date));
    expect((await call('GET', `/v1/superadmin/oxiopay-settlements/${ID}/document`, auth)).statusCode).toBe(200);
    const one = await call('GET', `/v1/superadmin/oxiopay-settlements/${ID}`, auth);
    expect(one.json()).toMatchObject({ reference: 'OXP-2026-S44-LUNA' });
    const csv = await call('GET', `/v1/superadmin/oxiopay-settlements/${ID}/csv`, auth);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect((await call('GET', '/v1/superadmin/oxiopay-settlements/payee', auth)).json()).toEqual({ payee: null });
    expect((await call('GET', '/v1/superadmin/oxiopay-settlements/no-es-un-id', auth)).statusCode).toBe(400);
  });

  it('apuntar un pago: sin código 400; con un código malo 403 TOTP_INVALID y no se apunta nada (queda en el registro)', async () => {
    const auth = await as(SUPER, 'OWNER');
    const body = { amountCents: 2_235, paidOn: '2026-11-03', bankReference: 'TRF-1' };
    expect((await call('POST', `/v1/superadmin/oxiopay-settlements/${ID}/payments`, auth, body)).statusCode).toBe(400);
    const bad = await call('POST', `/v1/superadmin/oxiopay-settlements/${ID}/payments`, auth, { ...body, totpCode: '000000' });
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ code: 'TOTP_INVALID' });
    expect(core.recordPayment).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'superadmin.step_up.failed', actorId: SUPER }));
  });

  it('anular sin motivo, generar con un día que no es lunes y una cuenta con un IBAN malo: 400 antes del 2FA', async () => {
    const auth = await as(SUPER, 'OWNER');
    expect((await call('POST', `/v1/superadmin/oxiopay-settlements/${ID}/void`, auth, { totpCode: '123456' })).statusCode).toBe(400);
    const notMonday = await call('POST', '/v1/superadmin/oxiopay-settlements/generate', auth, { venueId: TENANT, week: '2026-10-27', totpCode: '123456' });
    expect(notMonday.statusCode).toBe(400);
    const iban = await call('PUT', '/v1/superadmin/oxiopay-settlements/payee', auth, { name: 'OxioPay', iban: 'ES00 1234', holder: 'OxioPay SL', totpCode: '123456' });
    expect(iban.statusCode).toBe(400);
    expect(core.voidSettlement).not.toHaveBeenCalled();
    expect(core.generate).not.toHaveBeenCalled();
    expect(core.setPayee).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'superadmin.step_up.failed' }));
  });
});
