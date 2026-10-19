// Integración (Postgres real): la sesión del personal con la cookie HttpOnly.
// La app Nest de verdad (Fastify, prefijo /v1, AuthGuard y límite por IP),
// usuarios y audit_events en la base de pruebas; solo Redis es de mentira.
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { CLAIM_STEP_LUA } from '../../src/modules/auth/totp-attempts.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';

const r = randomUUID().slice(0, 6);
const ORIGIN = 'https://operator.paytomaxx.com';
const COOKIE = 'np_rt_operator.paytomaxx.com';
const PASSWORD = 'Clave-de-prueba-1';
const EMAIL = `chica-cookie-${r}@local.test`;
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);

let app: NestFastifyApplication;
let prisma: PrismaService;
let userId: string;

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: (cls: ClsService) => new PrismaService(cls as never), inject: [ClsService] },
    { provide: REDIS_CLIENT, useValue: redis },
    AuditService,
    { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: { inc: vi.fn() } } },
  ],
  exports: [PrismaService, REDIS_CLIENT, AuditService, MetricsService],
})
class InfraModule {}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: 'jwt-de-las-pruebas-de-integracion-0123456789', CORS_ORIGINS: ORIGIN })],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      InfraModule,
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
  prisma = app.get(PrismaService);

  const hash = await bcrypt.hash(PASSWORD, 4);
  await prisma.asSystem(async (tx) => {
    const venue = await tx.venue.create({ data: { name: `Cookie ${r}`, slug: `cookie-${r}` } });
    const user = await tx.user.create({ data: { tenantId: venue.id, email: EMAIL, passwordHash: hash, role: 'OPERATOR' } });
    userId = user.id;
  });
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  // Todas las peticiones salen de la misma IP: el tope de logins por minuto no es lo que se prueba.
  const keys = redis.keys().filter((k) => k.startsWith('nightpay:iprl:'));
  if (keys.length) await redis.del(...keys);
  vi.useRealTimers();
});

function post(url: string, opts: { cookie?: string; client?: boolean; body?: unknown } = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      origin: ORIGIN,
      ...(opts.client === false ? {} : { 'x-oxiopay-client': '1' }),
      ...(opts.cookie ? { cookie: `${COOKIE}=${opts.cookie}` } : {}),
    },
    payload: (opts.body ?? {}) as object,
  });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  if (!raw.startsWith(`${COOKIE}=`)) throw new Error(`Set-Cookie inesperado: ${raw}`);
  return raw.slice(COOKIE.length + 1).split(';')[0]!;
}

async function auditActions(): Promise<string[]> {
  const rows = await prisma.asSystem((tx) =>
    tx.auditEvent.findMany({ where: { actorId: userId }, orderBy: { id: 'asc' }, select: { action: true } }),
  );
  return rows.map((row) => row.action);
}

async function login(): Promise<string> {
  const res = await post('/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).not.toHaveProperty('refreshToken');
  return cookieOf(res);
}

describe('sesión del personal con cookie (Postgres real)', () => {
  it('login → cookie; refresh con la cookie → cookie rotada; queda en audit_events', async () => {
    const first = await login();
    const res = await post('/v1/auth/refresh', { cookie: first });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)).not.toBe(first);
    expect(res.json().accessToken).toEqual(expect.any(String));
    expect(await auditActions()).toEqual(expect.arrayContaining(['auth.login.ok', 'auth.refresh.ok']));
  });

  it('sin la cabecera X-OxioPay-Client → 403', async () => {
    const token = await login();
    expect((await post('/v1/auth/refresh', { cookie: token, client: false })).statusCode).toBe(403);
  });

  it('reuso de la cookie vieja pasado el margen → 401, sesión cerrada y apuntado en audit_events', async () => {
    const first = await login();
    const rotated = cookieOf(await post('/v1/auth/refresh', { cookie: first }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000);
    expect((await post('/v1/auth/refresh', { cookie: first })).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { cookie: rotated })).statusCode).toBe(401);
    vi.useRealTimers();
    expect(await auditActions()).toContain('auth.refresh.reuse_detected');
  });

  it('logout con la cookie → 204, la borra y la sesión ya no refresca', async () => {
    const token = await login();
    const res = await post('/v1/auth/logout', { cookie: token });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await post('/v1/auth/refresh', { cookie: token })).statusCode).toBe(401);
    expect(await auditActions()).toContain('auth.logout');
  });

  it('usuario dado de baja → el refresco da 401 y borra la cookie', async () => {
    const token = await login();
    await prisma.asSystem((tx) => tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } }));
    try {
      const res = await post('/v1/auth/refresh', { cookie: token });
      expect(res.statusCode).toBe(401);
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    } finally {
      await prisma.asSystem((tx) => tx.user.update({ where: { id: userId }, data: { deletedAt: null } }));
    }
  });
});
