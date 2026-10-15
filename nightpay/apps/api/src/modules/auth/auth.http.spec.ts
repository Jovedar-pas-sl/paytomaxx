import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import * as speakeasy from 'speakeasy';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IpRateLimitGuard } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import { AuthModule } from './auth.module';
import { CLAIM_STEP_LUA } from './totp-attempts.service';
import { totpStepAt } from './totp-code';
import { claimStepScript, createFakeRedis } from './testing/fake-redis';

/**
 * Contrato HTTP del módulo auth con la app Nest de verdad (Fastify, prefijo
 * /v1, AuthGuard y límite por IP globales); solo Postgres/Redis son de mentira.
 */
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

interface UserRow {
  id: string;
  email: string;
  tenantId: string;
  totpSecret: string | null;
  deletedAt: Date | null;
}

function makeUsers() {
  const users = new Map<string, UserRow>([
    [USER_ID, { id: USER_ID, email: 'dueno@local.es', tenantId: TENANT_ID, totpSecret: null, deletedAt: null }],
  ]);
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: Partial<UserRow>; data: Partial<UserRow> }) => {
        const row = where.id ? users.get(where.id) : undefined;
        if (!row || ('totpSecret' in where && row.totpSecret !== where.totpSecret)) return { count: 0 };
        users.set(row.id, { ...row, ...data });
        return { count: 1 };
      },
    },
  };
  const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
  return { users, prisma: { acrossVenues: run, asSystem: run } };
}

let app: NestFastifyApplication;
let bearer: string;
const { users, prisma } = makeUsers();

beforeAll(async () => {
  process.env.ENCRYPTION_KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: AuditService, useValue: { log: vi.fn().mockResolvedValue(undefined) } },
      { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() } } },
    ],
    exports: [PrismaService, REDIS_CLIENT, AuditService, MetricsService],
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
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const jwt = app.get(JwtService, { strict: false });
  bearer = `Bearer ${jwt.sign({ sub: USER_ID, email: 'dueno@local.es', role: 'OWNER', tenantId: TENANT_ID, venueSlug: 'luna' })}`;
});

afterAll(async () => {
  await app?.close();
});

function call(method: 'GET' | 'POST', url: string, body?: unknown, auth = true) {
  return app.inject({
    method,
    url,
    headers: { ...(auth ? { authorization: bearer } : {}), 'cf-connecting-ip': '203.0.113.7' },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

function codeAt(secret: string, offsetSteps = 0): string {
  return speakeasy.totp({ secret, encoding: 'base32', counter: totpStepAt(Date.now()) + offsetSteps });
}

describe('2FA: GET/POST /v1/auth/totp…', () => {
  let secret = '';

  it('sin sesión → 401', async () => {
    expect((await call('GET', '/v1/auth/totp', undefined, false)).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/totp/setup', undefined, false)).statusCode).toBe(401);
  });

  it('GET /v1/auth/totp → { enabled: false }, sin caché', async () => {
    const res = await call('GET', '/v1/auth/totp');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POST setup → exactamente { otpauthUrl, secret, qrPngDataUrl }', async () => {
    const res = await call('POST', '/v1/auth/totp/setup');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { otpauthUrl: string; secret: string; qrPngDataUrl: string };
    expect(Object.keys(body).sort()).toEqual(['otpauthUrl', 'qrPngDataUrl', 'secret']);
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/OxioPay:dueno%40local\.es\?secret=/);
    expect(body.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
    secret = body.secret;
  });

  it('POST confirm con código mal escrito → 400 (validación)', async () => {
    expect((await call('POST', '/v1/auth/totp/confirm', { code: 'abc' })).statusCode).toBe(400);
  });

  it('POST confirm con código malo → 403 en castellano', async () => {
    const res = await call('POST', '/v1/auth/totp/confirm', { code: '000000' });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/Código 2FA incorrecto/);
  });

  it('POST confirm con el código de la app ("123 456" también vale) → { enabled: true }', async () => {
    const code = codeAt(secret);
    const res = await call('POST', '/v1/auth/totp/confirm', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
    expect(users.get(USER_ID)!.totpSecret).toMatch(/^tv1:/);
    expect((await call('GET', '/v1/auth/totp')).json()).toEqual({ enabled: true });
  });

  it('POST setup ya activada → 409', async () => {
    expect((await call('POST', '/v1/auth/totp/setup')).statusCode).toBe(409);
  });

  it('POST disable: código malo 403; bueno → { enabled: false }', async () => {
    expect((await call('POST', '/v1/auth/totp/disable', { code: '000000' })).statusCode).toBe(403);
    const res = await call('POST', '/v1/auth/totp/disable', { code: codeAt(secret, 1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    expect(users.get(USER_ID)!.totpSecret).toBeNull();
  });
});
