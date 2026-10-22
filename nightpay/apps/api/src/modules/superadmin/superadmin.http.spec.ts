import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
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
import { SuperAdminOverviewService } from './overview.service';
import { SuperAdminModule } from './superadmin.module';

/**
 * El módulo de la consola con la app Nest de verdad (Fastify, prefijo /v1,
 * AuthGuard y límite por IP globales): que arranca (inyecciones), que las
 * rutas están detrás de SuperAdminGuard y que el step-up responde con su code.
 * Solo Postgres/Redis/email son de mentira.
 */
const SUPER = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const VENUE = '00000000-0000-4000-8000-0000000000bb';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const users = new Map<string, Record<string, unknown>>([
  [SUPER, { id: SUPER, email: 'jefe@x.es', isSuperAdmin: true, deletedAt: null, totpSecret: SECRET }],
  [OWNER, { id: OWNER, email: 'dueno@x.es', isSuperAdmin: false, deletedAt: null, totpSecret: null }],
]);
const tx = { user: { findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null } };
const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
const prisma = { acrossVenues: run, asSystem: run };
const audit = { log: vi.fn().mockResolvedValue(undefined) };

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
      // JwtService para el AuthGuard global (como en la app: AppModule importa AuthModule).
      AuthModule,
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
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  jwt = app.get(JwtService, { strict: false });
  vi.spyOn(app.get(SuperAdminOverviewService), 'overview').mockResolvedValue({ businesses: [] } as never);
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  users.set(SUPER, { ...users.get(SUPER), isSuperAdmin: true, totpSecret: SECRET });
});

function bearer(sub: string, sid?: string): string {
  return `Bearer ${jwt.sign({ sub, email: 'x@x.es', role: 'OWNER', tenantId: TENANT, venueSlug: 'casa', ...(sid ? { sid } : {}) })}`;
}

async function session(sub = SUPER, verified = true) {
  const tokens = app.get(RefreshTokenService);
  const issued = await tokens.issue(sub, TENANT);
  if (verified) await tokens.markTwoFactor(issued.family);
  return { ...issued, authorization: bearer(sub, issued.family), tokens };
}

async function call(method: 'GET' | 'POST', url: string, sub?: string, body?: unknown) {
  const authorization = sub ? (await session(sub)).authorization : undefined;
  return app.inject({
    method,
    url,
    headers: { ...(authorization ? { authorization } : {}), 'cf-connecting-ip': '203.0.113.7' },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

describe('/v1/superadmin con la app de verdad', () => {
  const overview = (authorization: string) => app.inject({ method: 'GET', url: '/v1/superadmin/overview', headers: { authorization } });

  it('sin sesión → 401', async () => {
    expect((await call('GET', '/v1/superadmin/overview')).statusCode).toBe(401);
  });

  it('un dueño que no es super-admin → 403 aunque tenga sesión', async () => {
    const res = await call('GET', '/v1/superadmin/overview', OWNER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ detail: 'Solo para super-admins' });
  });

  it('super-admin (leído de la base) → 200', async () => {
    const res = await call('GET', '/v1/superadmin/overview', SUPER);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ businesses: [] });
  });

  it('token anterior a promoción sin MFA en su sesión → 403', async () => {
    users.set(SUPER, { ...users.get(SUPER), isSuperAdmin: false });
    const old = await session(SUPER, false);
    users.set(SUPER, { ...users.get(SUPER), isSuperAdmin: true });
    expect((await overview(old.authorization)).statusCode).toBe(403);
  });

  it('JWT firmado sin sid → 401', async () => {
    expect((await overview(bearer(SUPER))).statusCode).toBe(401);
  });

  it('logout y revocación de refresh invalidan el acceso global inmediatamente', async () => {
    for (const revokeAll of [false, true]) {
      const current = await session();
      expect((await overview(current.authorization)).statusCode).toBe(200);
      if (revokeAll) await current.tokens.revokeAllForUser(SUPER);
      else await current.tokens.revoke(current.token);
      expect((await overview(current.authorization)).statusCode).toBe(401);
    }
  });

  it('2FA restablecida rechaza incluso con una sesión verificada aún viva', async () => {
    const current = await session();
    users.set(SUPER, { ...users.get(SUPER), totpSecret: null });
    expect((await overview(current.authorization)).statusCode).toBe(403);
  });

  it('no permite usar la family verificada de otro usuario', async () => {
    const other = await session(OWNER);
    expect((await overview(bearer(SUPER, other.family))).statusCode).toBe(401);
  });

  it('pausar un local sigue exigiendo step-up: sin código → 400; código malo → 403 TOTP_INVALID', async () => {
    const noCode = await call('POST', `/v1/superadmin/venues/${VENUE}/pause`, SUPER, { reason: 'impagos' });
    expect(noCode.statusCode).toBe(400);
    const res = await call('POST', `/v1/superadmin/venues/${VENUE}/pause`, SUPER, { reason: 'impagos', totpCode: '123 456' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TOTP_INVALID' });
    // El intento queda en el registro.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'superadmin.step_up.failed', actorId: SUPER, ip: expect.any(String) }),
    );
  });
});
