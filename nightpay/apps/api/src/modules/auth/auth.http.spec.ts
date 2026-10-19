import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
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
import { passwordFingerprint, RefreshTokenService } from './refresh-token.service';
import { CLAIM_STEP_LUA } from './totp-attempts.service';
import { totpStepAt } from './totp-code';
import { claimStepScript, createFakeRedis } from './testing/fake-redis';

/**
 * Contrato HTTP del módulo auth con la app Nest de verdad (Fastify, prefijo
 * /v1, AuthGuard y límite por IP globales); solo Postgres/Redis son de mentira.
 */
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

const PASSWORD = 'Clave-de-prueba-1';
// Coste 4: un hash de verdad para el login, sin hacer lentas las pruebas.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const EMAIL = 'dueno@local.es';
/** Orígenes permitidos (CORS_ORIGINS) y la cookie de la app del panel. */
const ADMIN_ORIGIN = 'https://admin.paytomaxx.com';
const TPV_ORIGIN = 'https://tpv.paytomaxx.com';
const ADMIN_COOKIE = 'np_rt_admin.paytomaxx.com';
/** Lejos: las pruebas de la vía antigua no dependen del día en que se pasen. */
const BODY_REFRESH_UNTIL = '2099-01-01T00:00:00+01:00';

interface UserRow {
  id: string;
  email: string;
  tenantId: string;
  role: 'OWNER';
  passwordHash: string;
  isSuperAdmin: boolean;
  venue: { slug: string };
  totpSecret: string | null;
  deletedAt: Date | null;
}

function makeUsers() {
  const users = new Map<string, UserRow>([
    [
      USER_ID,
      {
        id: USER_ID,
        email: 'dueno@local.es',
        tenantId: TENANT_ID,
        role: 'OWNER',
        passwordHash: PASSWORD_HASH,
        isSuperAdmin: false,
        venue: { slug: 'luna' },
        totpSecret: null,
        deletedAt: null,
      },
    ],
  ]);
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      findMany: async ({ where }: { where: { email: { equals: string } } }) =>
        [...users.values()].filter((u) => u.email.toLowerCase() === where.email.equals && !u.deletedAt),
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
let expiredBearer: string;
const { users, prisma } = makeUsers();
const bodyRefreshMetric = { inc: vi.fn() };
let fakeRedis: ReturnType<typeof createFakeRedis>;

/** Todas las peticiones de inject salen de la misma IP: el tope de 10 logins/min no es lo que se prueba. */
async function resetIpRateLimits(): Promise<void> {
  const keys = fakeRedis.keys().filter((k) => k.startsWith('nightpay:iprl:'));
  if (keys.length > 0) await fakeRedis.del(...keys);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
  const redis = createFakeRedis();
  redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
  fakeRedis = redis;

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: AuditService, useValue: { log: vi.fn().mockResolvedValue(undefined) } },
      { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: bodyRefreshMetric } },
    ],
    exports: [PrismaService, REDIS_CLIENT, AuditService, MetricsService],
  })
  class FakeInfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            JWT_SECRET: 'test_jwt_secret_0123456789abcdef0123456789',
            CORS_ORIGINS: `${ADMIN_ORIGIN},${TPV_ORIGIN}`,
            AUTH_BODY_REFRESH_UNTIL: BODY_REFRESH_UNTIL,
          }),
        ],
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
  const claims = { sub: USER_ID, email: 'dueno@local.es', role: 'OWNER', tenantId: TENANT_ID, venueSlug: 'luna' };
  bearer = `Bearer ${jwt.sign(claims)}`;
  expiredBearer = `Bearer ${jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 })}`;
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
    // El panel decide con el código; el texto solo tiene que ser en castellano.
    expect(res.json()).toMatchObject({ code: 'TOTP_INVALID', detail: expect.stringMatching(/incorrecto/) });
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

describe('sesiones de apps antiguas (refresh token en el cuerpo): /v1/auth/logout y /v1/auth/refresh', () => {
  async function newSession(): Promise<string> {
    const tokens = app.get(RefreshTokenService, { strict: false });
    const { token } = await tokens.issue(USER_ID, TENANT_ID, { pwdFp: passwordFingerprint(PASSWORD_HASH) });
    return token;
  }

  function post(url: string, body: unknown, authorization?: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { ...(authorization ? { authorization } : {}), 'cf-connecting-ip': '203.0.113.9' },
      payload: body as object,
    });
  }

  it('logout solo con el refresh token (sin access token) → 204 y el refresh ya no vale', async () => {
    const refreshToken = await newSession();
    expect((await post('/v1/auth/logout', { refreshToken })).statusCode).toBe(204);
    expect((await post('/v1/auth/refresh', { refreshToken })).statusCode).toBe(401);
  });

  it('logout con el access token caducado → 204 igualmente (antes daba 401 y no revocaba)', async () => {
    const refreshToken = await newSession();
    expect((await post('/v1/auth/logout', { refreshToken }, expiredBearer)).statusCode).toBe(204);
    expect((await post('/v1/auth/refresh', { refreshToken })).statusCode).toBe(401);
  });

  it('dos refrescos a la vez con el mismo token → los dos 200 con el mismo par nuevo', async () => {
    const refreshToken = await newSession();
    const [a, b] = await Promise.all([
      post('/v1/auth/refresh', { refreshToken }),
      post('/v1/auth/refresh', { refreshToken }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().refreshToken).toBe(b.json().refreshToken);
  });

  it('cambia la contraseña → el siguiente refresco da 401 y la sesión queda cerrada', async () => {
    const refreshToken = await newSession();
    const first = await post('/v1/auth/refresh', { refreshToken });
    expect(first.statusCode).toBe(200);

    users.set(USER_ID, { ...users.get(USER_ID)!, passwordHash: '$2a$10$otraContrasenaNueva' });
    try {
      const res = await post('/v1/auth/refresh', { refreshToken: first.json().refreshToken });
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toMatch(/contraseña ha cambiado/);
    } finally {
      users.set(USER_ID, { ...users.get(USER_ID)!, passwordHash: PASSWORD_HASH });
    }
  });
});

describe('sesión en cookie HttpOnly (apps nuevas)', () => {
  interface CookieCall {
    origin?: string | null;
    client?: string | null;
    cookie?: string;
    body?: unknown;
  }

  function cookieCall(url: string, opts: CookieCall = {}) {
    const origin = opts.origin === undefined ? ADMIN_ORIGIN : opts.origin;
    const client = opts.client === undefined ? '1' : opts.client;
    return app.inject({
      method: 'POST',
      url,
      headers: {
        'cf-connecting-ip': '203.0.113.11',
        ...(origin !== null ? { origin } : {}),
        ...(client !== null ? { 'x-oxiopay-client': client } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      payload: (opts.body ?? {}) as object,
    });
  }

  function setCookieOf(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const value = Array.isArray(raw) ? raw.join('\n') : raw;
    if (typeof value !== 'string') throw new Error('sin Set-Cookie');
    return value;
  }

  const COOKIE_START = `${ADMIN_COOKIE}=`;

  /** El refresh token que lleva un Set-Cookie de la app del panel. */
  function tokenIn(setCookie: string): string {
    if (!setCookie.startsWith(COOKIE_START)) throw new Error(`Set-Cookie inesperado: ${setCookie}`);
    return setCookie.slice(COOKIE_START.length).split(';')[0]!;
  }

  async function loginWithCookie(): Promise<string> {
    const res = await cookieCall('/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return tokenIn(setCookieOf(res));
  }

  beforeEach(resetIpRateLimits);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('login: Set-Cookie HttpOnly, SameSite=Strict, Path=/v1/auth, solo de este host, 30 días; el cuerpo no lleva el refresh', async () => {
    const res = await cookieCall('/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = setCookieOf(res);
    expect(tokenIn(cookie)).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(cookie).toContain('Path=/v1/auth');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Domain=/i);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user).toMatchObject({ id: USER_ID, venueSlug: 'luna' });
    expect(body).not.toHaveProperty('refreshToken');
  });

  it('una cookie por app: el TPV no pisa la del panel', async () => {
    const res = await cookieCall('/v1/auth/login', { origin: TPV_ORIGIN, body: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(setCookieOf(res).startsWith('np_rt_tpv.paytomaxx.com=')).toBe(true);
  });

  it('login de app nueva desde un Origin que no está en CORS_ORIGINS → 403 (ni se mira la contraseña)', async () => {
    const res = await cookieCall('/v1/auth/login', {
      origin: 'https://evil.example',
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refresh con cookie + Origin + cabecera → 200, cookie rotada y sin refresh en el cuerpo', async () => {
    const first = await loginWithCookie();
    const res = await cookieCall('/v1/auth/refresh', { cookie: `otra=1; ${ADMIN_COOKIE}=${first}` });
    expect(res.statusCode).toBe(200);
    const rotated = tokenIn(setCookieOf(res));
    expect(rotated).not.toBe(first);
    expect(setCookieOf(res)).toContain('Max-Age=2592000');
    expect(res.json().accessToken).toEqual(expect.any(String));
    expect(res.json()).not.toHaveProperty('refreshToken');
  });

  it('refresh sin la cabecera X-OxioPay-Client → 403 (CSRF) y la cookie sigue valiendo', async () => {
    const token = await loginWithCookie();
    const res = await cookieCall('/v1/auth/refresh', { client: null, cookie: `${ADMIN_COOKIE}=${token}` });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${token}` })).statusCode).toBe(200);
  });

  it('refresh con la cabecera mal puesta, sin Origin, Origin ajeno o "null" → 403', async () => {
    const cookie = `${ADMIN_COOKIE}=${await loginWithCookie()}`;
    expect((await cookieCall('/v1/auth/refresh', { client: 'true', cookie })).statusCode).toBe(403);
    expect((await cookieCall('/v1/auth/refresh', { origin: null, cookie })).statusCode).toBe(403);
    expect((await cookieCall('/v1/auth/refresh', { origin: 'https://evil.example', cookie })).statusCode).toBe(403);
    expect((await cookieCall('/v1/auth/refresh', { origin: 'null', cookie })).statusCode).toBe(403);
    // Origin exacto: con barra al final o el propio API no valen.
    expect((await cookieCall('/v1/auth/refresh', { origin: `${ADMIN_ORIGIN}/`, cookie })).statusCode).toBe(403);
    expect((await cookieCall('/v1/auth/refresh', { origin: 'https://api.paytomaxx.com', cookie })).statusCode).toBe(403);
  });

  it('refresh sin cookie → 401 y se manda borrar la cookie', async () => {
    const res = await cookieCall('/v1/auth/refresh');
    expect(res.statusCode).toBe(401);
    const cleared = setCookieOf(res);
    expect(cleared.startsWith(`${ADMIN_COOKIE}=; Path=/v1/auth; Max-Age=0`)).toBe(true);
  });

  it('reuso: la cookie vieja pasado el margen → 401 y se cierra la sesión entera (también la cookie nueva)', async () => {
    const first = await loginWithCookie();
    const res = await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${first}` });
    const rotated = tokenIn(setCookieOf(res));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000); // pasado el margen de 10 s
    const reuse = await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${first}` });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().detail).toMatch(/cerrada por seguridad/);
    expect(setCookieOf(reuse)).toContain('Max-Age=0');
    expect((await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${rotated}` })).statusCode).toBe(401);
  });

  it('logout con la cookie → 204, borra la cookie y la sesión ya no refresca', async () => {
    const token = await loginWithCookie();
    const res = await cookieCall('/v1/auth/logout', { cookie: `${ADMIN_COOKIE}=${token}` });
    expect(res.statusCode).toBe(204);
    const cleared = setCookieOf(res);
    expect(cleared.startsWith(`${ADMIN_COOKIE}=; `)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/v1/auth');
    expect((await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${token}` })).statusCode).toBe(401);
  });

  it('logout con la cookie pero sin la cabecera → 403 (un sitio ajeno no te saca)', async () => {
    const token = await loginWithCookie();
    const res = await cookieCall('/v1/auth/logout', { client: null, cookie: `${ADMIN_COOKIE}=${token}` });
    expect(res.statusCode).toBe(403);
    expect((await cookieCall('/v1/auth/refresh', { cookie: `${ADMIN_COOKIE}=${token}` })).statusCode).toBe(200);
  });

  it('app nueva pasando a la cookie la sesión de la antigua (refresh token del cuerpo + cabecera) → Set-Cookie', async () => {
    const tokens = app.get(RefreshTokenService, { strict: false });
    const { token } = await tokens.issue(USER_ID, TENANT_ID, { pwdFp: passwordFingerprint(PASSWORD_HASH) });
    bodyRefreshMetric.inc.mockClear();
    const res = await cookieCall('/v1/auth/refresh', { body: { refreshToken: token } });
    expect(res.statusCode).toBe(200);
    expect(tokenIn(setCookieOf(res))).not.toBe(token);
    expect(res.json()).not.toHaveProperty('refreshToken');
    expect(bodyRefreshMetric.inc).toHaveBeenCalledWith({ route: 'refresh', client: 'migration', result: 'allowed' });
  });
});

describe('apps antiguas: refresh token en el cuerpo hasta AUTH_BODY_REFRESH_UNTIL', () => {
  function legacy(url: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { 'cf-connecting-ip': '203.0.113.12', origin: ADMIN_ORIGIN },
      payload: body as object,
    });
  }

  beforeEach(resetIpRateLimits);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('antes de la fecha: el login devuelve el refresh en el cuerpo y no pone cookie; el refresh lo acepta', async () => {
    bodyRefreshMetric.inc.mockClear();
    const login = await legacy('/v1/auth/login', { email: EMAIL, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeUndefined();
    const refreshToken = login.json().refreshToken as string;
    expect(refreshToken).toMatch(/^[0-9a-f-]{36}\./);

    const res = await legacy('/v1/auth/refresh', { refreshToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(bodyRefreshMetric.inc).toHaveBeenCalledWith({ route: 'login', client: 'legacy', result: 'allowed' });
    expect(bodyRefreshMetric.inc).toHaveBeenCalledWith({ route: 'refresh', client: 'legacy', result: 'allowed' });
  });

  it('pasada la fecha: el refresh del cuerpo da 401 (se cuenta como closed) y el login ya no lo devuelve', async () => {
    const login = await legacy('/v1/auth/login', { email: EMAIL, password: PASSWORD });
    const refreshToken = login.json().refreshToken as string;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-02T00:00:00+01:00'));
    bodyRefreshMetric.inc.mockClear();
    const res = await legacy('/v1/auth/refresh', { refreshToken });
    expect(res.statusCode).toBe(401);
    expect(bodyRefreshMetric.inc).toHaveBeenCalledWith({ route: 'refresh', client: 'legacy', result: 'closed' });

    const late = await legacy('/v1/auth/login', { email: EMAIL, password: PASSWORD });
    expect(late.statusCode).toBe(200);
    expect(late.json()).not.toHaveProperty('refreshToken');

    // Cerrar sesión con el del cuerpo se acepta siempre: solo revoca.
    expect((await legacy('/v1/auth/logout', { refreshToken })).statusCode).toBe(204);
  });
});
