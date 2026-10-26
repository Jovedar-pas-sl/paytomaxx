// Integración (Postgres real): cerrar una sesión corta AL MOMENTO el token de
// acceso ya emitido (antes seguía entrando hasta caducar, 1 h). La app Nest de
// verdad (Fastify, prefijo /v1, AuthGuard), usuarios, cobros y audit_events en
// la base de pruebas; solo Redis es de mentira. Cubre: logout, revocar todas
// las sesiones (móvil perdido), revocar una (reuso del refresh), dar de baja,
// resetear la contraseña, tokens sin el campo `sid`, Redis caído (503) y el
// tiempo real. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Controller, Get, Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { JwtPayload } from '@nightpay/contracts';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AccessRevocationService } from '../../src/modules/auth/access-revocation.service';
import { RefreshTokenService } from '../../src/modules/auth/refresh-token.service';
import { CLAIM_STEP_LUA } from '../../src/modules/auth/totp-attempts.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { RealtimeGateway, SESSION_REVOKED_ERROR } from '../../src/modules/realtime/realtime.gateway';

const r = randomUUID().slice(0, 6);
const ORIGIN = 'https://admin.paytomaxx.com';
const COOKIE = 'np_rt_admin.paytomaxx.com';
const PASSWORD = 'Clave-de-prueba-1';
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);

/** Una ruta del panel cualquiera (como /v1/admin/payments): solo pide sesión. */
@Controller('prueba')
class ProtegidaController {
  @Get('protegida')
  protegida(@CurrentUser() user: JwtPayload | undefined): { sub: string | null } {
    return { sub: user?.sub ?? null };
  }
}

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

let app: NestFastifyApplication;
let prisma: PrismaService;
let cls: ClsService;
let refreshTokens: RefreshTokenService;
let operators: OperatorsService;
let venueId: string;
let ownerId: string;
let terminalId: string;
let n = 0;

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
    controllers: [ProtegidaController],
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
  cls = app.get(ClsService);
  refreshTokens = app.get(RefreshTokenService);
  const audit = app.get(AuditService);
  const config = { get: (k: string) => (k === 'OPERATOR_BASE_URL' ? 'https://chicas.example.com' : undefined) };
  operators = new OperatorsService(prisma, {} as never, audit, config as never, app.get(JwtService), {} as never, refreshTokens);

  await prisma.asSystem(async (tx) => {
    const venue = await tx.venue.create({ data: { name: `Revocar ${r}`, slug: `revocar-${r}` } });
    venueId = venue.id;
    ownerId = (await tx.user.create({ data: { tenantId: venueId, email: `dueno-rev-${r}@local.test`, passwordHash: 'x', role: 'OWNER' } })).id;
    terminalId = (await tx.terminal.create({ data: { tenantId: venueId, externalId: `TREV-${r}`, label: 'Barra' } })).id;
  });
});

afterAll(async () => {
  await app?.close();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Todas las peticiones salen de la misma IP: el tope de logins por minuto no es lo que se prueba.
  const keys = redis.keys().filter((k) => k.startsWith('nightpay:iprl:'));
  if (keys.length) await redis.del(...keys);
});

/** Una persona nueva del local (cada prueba la suya). */
async function newUser(role: 'MANAGER' | 'OPERATOR' = 'MANAGER', password = PASSWORD): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `rev-${r}-${n}@local.test`;
  const passwordHash = await bcrypt.hash(password, 4);
  const id = await prisma.asSystem(async (tx) => (await tx.user.create({ data: { tenantId: venueId, email, passwordHash, role } })).id);
  return { id, email };
}

function post(url: string, opts: { cookie?: string; body?: unknown } = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, 'x-oxiopay-client': '1', ...(opts.cookie ? { cookie: `${COOKIE}=${opts.cookie}` } : {}) },
    payload: (opts.body ?? {}) as object,
  });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  if (!raw.startsWith(`${COOKIE}=`)) throw new Error(`Set-Cookie inesperado: ${raw}`);
  return raw.slice(COOKIE.length + 1).split(';')[0]!;
}

/** Login como en las apps: access token en el cuerpo, refresh en la cookie. */
async function login(email: string, password = PASSWORD): Promise<{ access: string; cookie: string }> {
  const res = await post('/v1/auth/login', { body: { email, password } });
  expect(res.statusCode).toBe(200);
  return { access: res.json().accessToken as string, cookie: cookieOf(res) };
}

function panel(access: string) {
  return app.inject({ method: 'GET', url: '/v1/prueba/protegida', headers: { authorization: `Bearer ${access}` } });
}

/** Como una petición del panel de ese local (tras AuthGuard). */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-${r}`, tenantId: venueId, userId: ownerId, role: 'OWNER' });
    return fn();
  });
}

const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;

describe('cerrar una sesión corta el token de acceso al momento (Postgres real)', () => {
  it('logout: el token de acceso de esa sesión → 401 SESSION_REVOKED; otra sesión de la misma persona sigue', async () => {
    const u = await newUser();
    const a = await login(u.email);
    const b = await login(u.email);
    expect((await panel(a.access)).statusCode).toBe(200);

    expect((await post('/v1/auth/logout', { cookie: a.cookie })).statusCode).toBe(204);
    const after = await panel(a.access);
    expect(after.statusCode).toBe(401);
    expect(codeOf(after)).toBe('SESSION_REVOKED');
    // El cuerpo dice el mismo código que la respuesta.
    expect((after.json() as { status: number }).status).toBe(401);
    expect((await panel(b.access)).statusCode).toBe(200);
  });

  it('el dueño revoca las sesiones del encargado (móvil perdido): todos sus tokens → 401, no refresca y puede volver a entrar', async () => {
    const enc = await newUser('MANAGER');
    const movil = await login(enc.email);
    const pc = await login(enc.email);
    expect((await panel(movil.access)).statusCode).toBe(200);

    // Lo que hace POST /v1/admin/users/:userId/revoke-sessions.
    await expect(refreshTokens.revokeAllForUser(enc.id)).resolves.toBe(2);
    expect((await panel(movil.access)).statusCode).toBe(401);
    expect((await panel(pc.access)).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { cookie: movil.cookie })).statusCode).toBe(401);

    // Entra otra vez (después): ese token vale.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_500);
    const again = await login(enc.email);
    expect((await panel(again.access)).statusCode).toBe(200);
  });

  it('revocar UNA sesión (reuso del refresh viejo = robo): esa sesión fuera, también su token más nuevo; la otra sigue', async () => {
    const u = await newUser();
    const robada = await login(u.email);
    const otra = await login(u.email);
    const rotated = await post('/v1/auth/refresh', { cookie: robada.cookie });
    expect(rotated.statusCode).toBe(200);
    const nuevo = rotated.json().accessToken as string;
    expect((await panel(nuevo)).statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000);
    expect((await post('/v1/auth/refresh', { cookie: robada.cookie })).statusCode).toBe(401);
    expect((await panel(nuevo)).statusCode).toBe(401);
    expect((await panel(robada.access)).statusCode).toBe(401);
    expect((await panel(otra.access)).statusCode).toBe(200);
  });

  it('dar de baja a la chica: su token → 401 al momento y ya no entra', async () => {
    const chica = await newUser('OPERATOR');
    const s = await login(chica.email);
    expect((await panel(s.access)).statusCode).toBe(200);
    await asOwner(() => operators.updateOperator(venueId, chica.id, ownerId, 'OWNER', { active: false }));
    expect((await panel(s.access)).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { body: { email: chica.email, password: PASSWORD } })).statusCode).toBe(401);
  });

  it('el dueño le resetea la contraseña: su token → 401 al momento; entra con la nueva', async () => {
    const chica = await newUser('OPERATOR');
    const s = await login(chica.email);
    await asOwner(() => operators.resetPassword(venueId, chica.id, ownerId, 'Nueva.Clave.2026'));
    expect((await panel(s.access)).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { cookie: s.cookie })).statusCode).toBe(401);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_500);
    const nueva = await login(chica.email, 'Nueva.Clave.2026');
    expect((await panel(nueva.access)).statusCode).toBe(200);
  });

  it('un token de antes de este cambio (sin `sid`) sigue valiendo hasta que caduca… salvo que se revoquen sus sesiones', async () => {
    const u = await newUser();
    const legacy = await app.get(JwtService).signAsync(
      { sub: u.id, email: u.email, role: 'MANAGER', tenantId: venueId, venueSlug: `revocar-${r}` },
      { expiresIn: 3_600 },
    );
    expect((await panel(legacy)).statusCode).toBe(200);
    // Emitido antes (no en el mismo segundo que la revocación: ese lo corta la marca de su sesión).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_500);
    await refreshTokens.revokeAllForUser(u.id);
    expect((await panel(legacy)).statusCode).toBe(401);
  });

  it('Redis no responde → 503 (sin dejar pasar a ciegas) y la sesión NO se cierra: al volver, el mismo token vale', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const u = await newUser();
    const s = await login(u.email);
    vi.spyOn(redis, 'mget').mockRejectedValueOnce(new Error('Connection is closed.'));
    const down = await panel(s.access);
    expect(down.statusCode).toBe(503);
    expect(codeOf(down)).toBe('SESSION_CHECK_UNAVAILABLE');
    expect((await panel(s.access)).statusCode).toBe(200);
  });
});

describe('tiempo real: una sesión cerrada deja de recibir eventos (Postgres real)', () => {
  function gateway() {
    const metrics = { wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() }, wsLegacySubscribes: { inc: vi.fn() } };
    const g = new RealtimeGateway(app.get(JwtService), prisma, metrics as never, app.get(AccessRevocationService), {
      get: () => 'off',
    } as never);
    const disconnectSockets = vi.fn();
    const server = { in: vi.fn(() => ({ disconnectSockets })) };
    g.server = server as never;
    return { g, server, disconnectSockets };
  }

  function socket(token: string) {
    const rooms = new Set<string>(['sock']);
    return {
      id: `sock-${randomUUID().slice(0, 4)}`,
      handshake: { auth: { token }, headers: {} },
      data: {} as Record<string, unknown>,
      rooms,
      join: vi.fn(async (room: string | string[]) => {
        for (const x of Array.isArray(room) ? room : [room]) rooms.add(x);
      }),
      leave: vi.fn(async (room: string) => {
        rooms.delete(room);
      }),
      disconnect: vi.fn(),
    };
  }

  async function payment(): Promise<string> {
    return prisma.asSystem(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId: venueId,
          terminalId,
          createdByUserId: ownerId,
          idempotencyKey: `k-${randomUUID()}`,
          amountCents: 2_000,
          availableAmountCents: 2_000,
          qrToken: `qr-${randomUUID()}`,
          qrExpiresAt: new Date(Date.now() + 4 * 60_000),
          revenueCategory: 'CHICA_SERVICE',
        },
      });
      return p.id;
    });
  }

  it('revocar sus sesiones cierra sus conexiones; volver a suscribirse o a conectar con ese token no vale', async () => {
    const { g, server, disconnectSockets } = gateway();
    const enc = await newUser('MANAGER');
    const s = await login(enc.email);
    const paymentId = await payment();

    const client = socket(s.access);
    await g.handleConnection(client as never);
    expect(client.rooms.has(`user:${enc.id}`)).toBe(true);
    await expect(g.handleSubscribe({ paymentId }, client as never)).resolves.toEqual({ ok: true, room: `payment:${paymentId}` });

    await refreshTokens.revokeAllForUser(enc.id);
    // Se cierran ya sus conexiones (con el adaptador de Redis, en todos los nodos).
    expect(server.in).toHaveBeenCalledWith(`user:${enc.id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    // Si el aviso no llegó a esta conexión, el siguiente subscribe la corta.
    await expect(g.handleSubscribe({ paymentId }, client as never)).resolves.toEqual({ ok: false, error: SESSION_REVOKED_ERROR });
    expect(client.disconnect).toHaveBeenCalledWith(true);

    const again = socket(s.access);
    await g.handleConnection(again as never);
    expect(again.disconnect).toHaveBeenCalledWith(true);
    expect(again.data.staff).toBeUndefined();
  });

  it('logout cierra las conexiones de esa sesión', async () => {
    const { server } = gateway();
    const u = await newUser();
    const s = await login(u.email);
    const sid = (app.get(JwtService).decode(s.access) as { sid: string }).sid;
    expect((await post('/v1/auth/logout', { cookie: s.cookie })).statusCode).toBe(204);
    expect(server.in).toHaveBeenCalledWith(`session:${sid}`);
  });
});
