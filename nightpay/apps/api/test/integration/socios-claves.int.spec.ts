// Integración (Postgres y Redis de verdad): la API de socios, claves y puerta.
// La app Nest de verdad (Fastify, prefijo /v1, filtro global, rawBody y los
// ganchos de main.ts), el guard de la clave, el panel del dueño y el enlace de
// un uso. La IP de cada petición, con inject({ remoteAddress }). Redis es el
// de REDIS_URL (en CI, el servicio del job `integracion`). Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Body, Controller, ForbiddenException, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  PARTNER_CONNECTION_EXAMPLE,
  PARTNER_ERRORS,
  PARTNER_KEY_RE,
  PARTNER_ROUTES,
  PartnerConnectionSchema,
  type PartnerRouteDef,
} from '@nightpay/contracts';
import { requestTraceId } from '../../src/common/context/trace-id';
import { EmailService } from '../../src/common/email/email.service';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { trustInternalProxy } from '../../src/common/http/client-ip';
import { UNPREFIXED_ROUTES } from '../../src/common/http/unprefixed-routes';
import { ZodValidationPipe } from '../../src/common/pipes/zod.pipe';
import { PrismaService, startRequestTxGate } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { TotpService } from '../../src/modules/auth/totp.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { LEGAL_UPDATED } from '../../src/modules/legal/legal-owner';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { CurrentConnection, type PartnerAuth } from '../../src/modules/partner/auth/current-connection.decorator';
import { installPartnerBodyLimit, installPartnerUrlCheck } from '../../src/modules/partner/http/partner-hooks';
import { PartnerRoute } from '../../src/modules/partner/http/partner-route.decorator';
import { PartnerModule } from '../../src/modules/partner/partner.module';
import { SuperAdminPartnersService } from '../../src/modules/superadmin/partners.service';
import { SuperAdminAuditService } from '../../src/modules/superadmin/superadmin-audit.service';

const r = randomUUID().slice(0, 6);
const JWT_SECRET = 'jwt-de-las-pruebas-de-socios-0123456789abcdef';
const OK_IP = '203.0.113.9';
const TOTP = '123456';
const DAY = 86_400_000;
const DOCS = join(__dirname, '../../../../docs/partner-api');

if (!process.env.REDIS_URL) {
  throw new Error('socios-claves necesita REDIS_URL (un Redis de usar y tirar): ver test/integration/README.md.');
}
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });

/** Una ruta de dinero de prueba (cargar), como llegarán en el PR 3. */
const MONEY: PartnerRouteDef = {
  ...PARTNER_ROUTES.getConnection,
  method: 'POST',
  path: '/prueba/cargar',
  operationId: 'pruebaCargar',
  scopes: ['wallet:load'],
  money: true,
  successStatus: 200,
  response: z.object({ ok: z.literal(true), connection: z.string() }),
  parameters: [],
  errorResponses: {
    '400': 'BadRequest',
    '401': 'Unauthorized',
    '403': 'ForbiddenMoney',
    '404': 'ApiOff',
    '413': 'PayloadTooLarge',
    '422': 'ValidationFailed',
    '429': 'RateLimited',
    '503': 'TryLater',
    '5XX': 'ServerError',
  },
  body: z.strictObject({ amount: z.number().int().min(1) }),
};

@Controller('partner')
class PruebaDineroController {
  @PartnerRoute(MONEY)
  cargar(@Body(new ZodValidationPipe(MONEY.body!)) _body: { amount: number }, @CurrentConnection() auth: PartnerAuth) {
    return { ok: true, connection: auth.connection.id, interno: auth.connection.keyHash };
  }
}

/** Correos de mentira: se guardan para sacar el enlace. */
const mails: Array<{ to: string; text?: string }> = [];
const email = {
  isEnabled: () => true,
  send: vi.fn(async (m: { to: string; text?: string }) => {
    mails.push(m);
    return { ok: true, delivered: true };
  }),
};
/** 2FA de mentira: vale el código TOTP y apunta la acción. */
const totpActions: string[] = [];
const totp = {
  assertForUser: vi.fn(async (_user: string, code: string | undefined, action?: string) => {
    if (code !== TOTP) throw new ForbiddenException({ code: 'TOTP_REQUIRED', message: 'Pon el código' });
    if (action) totpActions.push(action);
  }),
  isEnabled: async () => true,
};

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: (cls: ClsService) => new PrismaService(cls as never), inject: [ClsService] },
    { provide: REDIS_CLIENT, useValue: redis },
    AuditService,
    { provide: EmailService, useValue: email },
    { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: { inc: vi.fn() } } },
  ],
  exports: [PrismaService, REDIS_CLIENT, AuditService, EmailService, MetricsService],
})
class InfraModule {}

let app: NestFastifyApplication;
let prisma: PrismaService;
let cls: ClsService;
let jwt: JwtService;
let saConsole: SuperAdminPartnersService;
let partnerId: string;
let n = 0;

const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => cls.run(() => prisma.asSystem(fn)) as Promise<T>;

interface Venue {
  id: string;
  name: string;
  businessId: string;
  businessName: string;
  taxId: string;
  owner: string;
  manager: string;
}

async function newVenue(): Promise<Venue> {
  n += 1;
  const tag = `${r}${n}`;
  return sys<Venue>(async (tx) => {
    const taxId = `B${Date.now().toString().slice(-7)}${n}`;
    const business = await tx.business.create({ data: { name: `Empresa ${tag} S.L.`, taxId } });
    const venue = await tx.venue.create({ data: { name: `Sala Socios ${tag}`, slug: `socios-${tag}`, businessId: business.id } });
    const owner = await tx.user.create({ data: { tenantId: venue.id, email: `dueno-${tag}@socios.test`, passwordHash: 'x', role: 'OWNER' } });
    const manager = await tx.user.create({ data: { tenantId: venue.id, email: `encargado-${tag}@socios.test`, passwordHash: 'x', role: 'MANAGER' } });
    return { id: venue.id, name: venue.name, businessId: business.id, businessName: business.name, taxId, owner: owner.id, manager: manager.id };
  });
}

async function newPartner(over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  return sys<string>(async (tx) =>
    (
      await tx.partner.create({
        data: {
          name: `Cajeros ${r}${n}`.slice(0, 30),
          legalName: 'Cajeros Demo S.L.',
          taxId: 'B12345678',
          contactEmail: `it-${r}${n}@cajeros.test`,
          allowedScopes: ['wallet:balance', 'wallet:load'],
          egressIps: ['203.0.113.0/24', '2001:db8:42::/48'],
          egressRangeReason: 'Sus servidores en dos redes',
          kybCheckedAt: new Date(),
          dataRole: 'PROCESSOR_OF_VENUE',
          dpaSignedAt: new Date(),
          dpaVersion: 'v1',
          dataCountry: 'ES',
          createdById: randomUUID(),
          ...over,
        },
      })
    ).id,
  );
}

async function token(v: Venue, role: 'OWNER' | 'MANAGER' = 'OWNER'): Promise<string> {
  const sub = role === 'OWNER' ? v.owner : v.manager;
  return jwt.signAsync({ sub, email: `${sub}@socios.test`, role, tenantId: v.id, venueSlug: 'x' }, { expiresIn: 3_600 });
}

function admin(method: 'GET' | 'POST', v: Venue, path = '', body?: object, role: 'OWNER' | 'MANAGER' = 'OWNER') {
  return token(v, role).then((t) =>
    app.inject({
      method,
      url: `/v1/admin/partner-connections${path}`,
      headers: { authorization: `Bearer ${t}` },
      remoteAddress: OK_IP,
      ...(body ? { payload: body } : {}),
    }),
  );
}

interface Connected {
  id: string;
  key: string;
}

async function connect(v: Venue, over: Record<string, unknown> = {}, partner = partnerId): Promise<Connected> {
  const res = await admin('POST', v, '', {
    partnerId: partner,
    scopes: ['wallet:balance', 'wallet:load'],
    ipAllowlist: [OK_IP],
    expiresAt: new Date(Date.now() + 300 * DAY).toISOString(),
    delivery: 'copy',
    totpCode: TOTP,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { connection: { id: string }; key: string };
  return { id: body.connection.id, key: body.key };
}

function me(key: string, opts: { ip?: string; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: 'GET',
    url: '/v1/partner/me',
    headers: { authorization: `Bearer ${key}`, ...opts.headers },
    remoteAddress: opts.ip ?? OK_IP,
  });
}

function load(key: string, opts: { ip?: string; body?: unknown } = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/partner/prueba/cargar',
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: opts.ip ?? OK_IP,
    payload: (opts.body ?? { amount: 2000 }) as object,
  });
}

const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
const row = (id: string) => sys<Record<string, unknown> | null>((tx) => tx.partnerConnection.findUnique({ where: { id } }));
const setRow = (id: string, data: Record<string, unknown>) => sys((tx) => tx.partnerConnection.update({ where: { id }, data }));
const audits = (targetId: string, action: string) =>
  sys<Array<{ action: string; ip: string | null; payload: unknown }>>((tx) =>
    tx.auditEvent.findMany({ where: { targetId, action }, select: { action: true, ip: true, payload: true } }),
  );

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const out = await fn();
    if (out) return out;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No llegó: ${what}`);
}

async function clearRedis(): Promise<void> {
  for (const pattern of ['np:*', 'nightpay:iprl:*', 'nightpay:userrl:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

beforeAll(async () => {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET, NEXT_PUBLIC_API_URL: 'https://api.oxiopay.example', ENCRYPTION_KEK: process.env.ENCRYPTION_KEK })],
      }),
      ClsModule.forRoot({
        global: true,
        middleware: {
          mount: true,
          generateId: true,
          idGenerator: () => randomUUID(),
          // Como app.module.ts: en /v1/partner, el X-Request-Id.
          setup: (c, req: { url?: string; originalUrl?: string; headers?: Record<string, unknown> }) => {
            c.set('ctx', { traceId: requestTraceId(req, c.getId()) });
            startRequestTxGate(c);
          },
        },
      }),
      InfraModule,
      AuthModule,
      PartnerModule,
    ],
    controllers: [PruebaDineroController],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
    .overrideProvider(TotpService)
    .useValue(totp)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: trustInternalProxy }), { rawBody: true });
  installPartnerBodyLimit(app);
  installPartnerUrlCheck(app);
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  cls = app.get(ClsService);
  jwt = app.get(JwtService);
  // Unas conexiones del pool abiertas ya: en Windows «localhost» prueba antes IPv6 y
  // abrir cada una tarda unos 2 s, lo que espera Prisma para empezar una transacción
  // (las pruebas que hacen dos cosas a la vez fallaban con P2028).
  await Promise.all([0, 1, 2, 3].map(() => prisma.$executeRaw`SELECT pg_sleep(0.2)`));
  const audit = app.get(AuditService);
  saConsole = new SuperAdminPartnersService(prisma, redis, audit, { verify: async () => undefined } as never, new SuperAdminAuditService(audit));
  partnerId = await newPartner();
});

beforeEach(async () => {
  await clearRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
});

afterAll(async () => {
  await sys((tx) => tx.partnerApiState.update({ where: { id: 1 }, data: { freeze: 'none' } }));
  await clearRedis();
  await app?.close();
  await redis.quit();
  vi.unstubAllEnvs();
});

describe('GET /v1/partner/me', () => {
  it('responde como ConnectionAtm: la conexión, el emisor, los topes y las condiciones', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const res = await me(c.key);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(Object.keys(PARTNER_CONNECTION_EXAMPLE.value));
    expect(PartnerConnectionSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      object: 'connection',
      id: `pc_${c.id.replace(/-/g, '')}`,
      venue_name: v.name,
      issuer: { legal_name: v.businessName, tax_id: v.taxId },
      collection_model: 'venue_collects',
      channel: 'in_venue',
      status: 'active',
      scopes: ['wallet:balance', 'wallet:load'],
      paused_scopes: [],
      livemode: false,
      key: { hint: `oxp_test_…${c.key.slice(-4)}`, replaced: false },
      limits: PARTNER_CONNECTION_EXAMPLE.value.limits,
      terms: { ...PARTNER_CONNECTION_EXAMPLE.value.terms, url: 'https://api.oxiopay.example/legal/condiciones#saldo', version: LEGAL_UPDATED },
    });
    expect(totpActions).toContain(`partner:create:${partnerId}`);
    // GET /me no mantiene viva la clave (solo las llamadas de saldo).
    expect((await row(c.id))?.lastUsedAt).toBeNull();
  });

  it('X-Request-Id válido vuelve en Request-Id; Accept-Language: es da el detalle en español', async () => {
    const v = await newVenue();
    const c = await connect(v);
    expect((await me(c.key, { headers: { 'x-request-id': 'atm0042-req-000731-1' } })).headers['request-id']).toBe('atm0042-req-000731-1');
    const bad = await me(`oxp_test_${'0'.repeat(48)}`, { headers: { 'accept-language': 'es-ES,es;q=0.9', 'x-request-id': 'atm0042-req-2' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(bad.headers['request-id']).toBe('atm0042-req-2');
    expect(bad.json()).toEqual({
      type: 'https://docs.oxiopay.example/errors/invalid_api_key',
      title: 'Invalid API key',
      status: 401,
      code: 'invalid_api_key',
      detail: PARTNER_ERRORS.invalid_api_key.es,
      request_id: 'atm0042-req-2',
    });
    expect((await me(c.key, { headers: { 'x-request-id': 'con espacios' } })).headers['request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('aislamiento entre locales', () => {
  it('el dueño y el encargado de A no ven la conexión de B y sus escrituras dan 404 sin tocarla', async () => {
    const a = await newVenue();
    const b = await newVenue();
    const cb = await connect(b);
    const before = await row(cb.id);
    for (const role of ['OWNER', 'MANAGER'] as const) {
      const list = await admin('GET', a, '', undefined, role);
      expect(list.statusCode).toBe(200);
      expect((list.json() as { connections: unknown[] }).connections).toEqual([]);
      for (const action of ['pause', 'revoke']) {
        const res = await admin('POST', a, `/${cb.id}/${action}`, undefined, role);
        expect(res.statusCode).toBe(404);
        expect(codeOf(res)).toBe('PARTNER_CONNECTION_NOT_FOUND');
      }
    }
    expect(codeOf(await admin('POST', a, `/${cb.id}/rotate`, { overlap: 'none', expiresAt: null, delivery: 'copy', totpCode: TOTP }))).toBe(
      'PARTNER_CONNECTION_NOT_FOUND',
    );
    expect(codeOf(await admin('POST', a, `/${cb.id}/resume`, { totpCode: TOTP }))).toBe('PARTNER_CONNECTION_NOT_FOUND');
    expect(await row(cb.id)).toEqual(before);
    // El encargado ve las suyas, pausa y anula; conectar y reanudar son del dueño.
    const own = await admin('GET', b, '', undefined, 'MANAGER');
    expect((own.json() as { connections: Array<{ id: string }>; partners: unknown[] }).connections.map((x) => x.id)).toEqual([cb.id]);
    expect((own.json() as { partners: unknown[] }).partners).toEqual([]);
    expect((await admin('POST', b, '', { partnerId, scopes: ['wallet:balance'], ipAllowlist: [], expiresAt: null, delivery: 'copy' }, 'MANAGER')).statusCode).toBe(403);
    expect((await admin('POST', b, `/${cb.id}/pause`, undefined, 'MANAGER')).statusCode).toBe(200);
    expect(await row(cb.id)).toMatchObject({ status: 'PAUSED', pausedReason: 'manager' });
  });

  it('un JWT del personal en /v1/partner/me y una clave oxp_ en una ruta interna: 401', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const staff = await me(await token(v));
    expect(staff.statusCode).toBe(401);
    expect(codeOf(staff)).toBe('invalid_api_key');
    const internal = await app.inject({ method: 'GET', url: '/v1/admin/partner-connections', headers: { authorization: `Bearer ${c.key}` }, remoteAddress: OK_IP });
    expect(internal.statusCode).toBe(401);
  });
});

describe('la clave fuera de su sitio', () => {
  it('en la URL (ruta o query): 400 api_key_in_url, keyExposedAt y una Incidencia; también en rutas que no existen', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const inPath = await app.inject({ method: 'GET', url: `/v1/partner/${c.key}/me`, remoteAddress: OK_IP });
    expect(inPath.statusCode).toBe(400);
    expect(codeOf(inPath)).toBe('api_key_in_url');
    const inQuery = await app.inject({ method: 'GET', url: `/v1/partner/openapi.json?k=${encodeURIComponent(c.key)}`, remoteAddress: OK_IP });
    expect(codeOf(inQuery)).toBe('api_key_in_url');
    expect(inQuery.headers['cache-control']).toBe('no-store');
    await until(async () => (await row(c.id))?.keyExposedAt, 'keyExposedAt');
    expect(await audits(c.id, 'partner.key.exposed')).toHaveLength(1);
    const inbox = await cls.run(async () => {
      cls.set('ctx', { traceId: 't-socios', tenantId: v.id });
      return new IncidentsService(prisma, app.get(AuditService)).list(v.id);
    });
    expect(inbox.map((i) => i.title)).toContain('Clave en una dirección web');
  });

  it('en el cuerpo: 400 api_key_in_body; con Origin: 403 browser_not_allowed', async () => {
    const v = await newVenue();
    const c = await connect(v);
    expect(codeOf(await load(c.key, { body: { amount: 5, nota: c.key } }))).toBe('api_key_in_body');
    const browser = await app.inject({ method: 'GET', url: '/v1/partner/me', headers: { authorization: `Bearer ${c.key}`, origin: 'https://evil.example' }, remoteAddress: OK_IP });
    expect(codeOf(browser)).toBe('browser_not_allowed');
  });

  it('16.385 bytes troceados (sin content-length): 413 body_too_large', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/partner/prueba/cargar',
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
      remoteAddress: OK_IP,
      payload: Readable.from([Buffer.from('{"amount":1,"x":"'), Buffer.alloc(16_385 - 19, 0x61), Buffer.from('"}')]),
    });
    expect(res.statusCode).toBe(413);
    expect(codeOf(res)).toBe('body_too_large');
  });

  it('cuerpos del contrato: [] y otro Content-Type, 400 invalid_request; un campo de más, 422 con ese campo', async () => {
    const v = await newVenue();
    const c = await connect(v);
    expect(codeOf(await load(c.key, { body: [] }))).toBe('invalid_request');
    const text = await app.inject({ method: 'POST', url: '/v1/partner/prueba/cargar', headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/xml' }, remoteAddress: OK_IP, payload: '<a/>' });
    expect(codeOf(text)).toBe('invalid_request');
    expect(await load(c.key, { body: { amount: 5, extra: 1 } }).then((res) => res.json())).toMatchObject({ code: 'validation_failed', param: 'extra' });
    expect(await load(c.key, { body: { amount: 0 } }).then((res) => res.json())).toMatchObject({ code: 'validation_failed', param: 'amount' });
    const ok = await load(c.key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true, connection: c.id });
  });
});

describe('la IP', () => {
  it('X-Forwarded-For inventado y CF-Connecting-IP sin pasar por Cloudflare no cuentan', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const direct = await me(c.key, { ip: '198.51.100.7', headers: { 'x-forwarded-for': OK_IP, 'cf-connecting-ip': OK_IP } });
    expect(codeOf(direct)).toBe('ip_not_allowed');
    const viaProxy = await me(c.key, { ip: '10.0.1.7', headers: { 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': OK_IP } });
    expect(codeOf(viaProxy)).toBe('ip_not_allowed');
    expect((await me(c.key, { ip: '10.0.1.7', headers: { 'x-forwarded-for': `198.51.100.1, ${OK_IP}` } })).statusCode).toBe(200);
  });

  it('desde tres IP ajenas en 24 h: avisos y cargas en pausa (scope_paused); leer sigue', async () => {
    const v = await newVenue();
    const c = await connect(v);
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.2', '198.51.100.3']) {
      expect(codeOf(await load(c.key, { ip }))).toBe('ip_not_allowed');
    }
    const foreign = await audits(c.id, 'partner.foreign_ip');
    expect(foreign.map((a) => a.ip).sort()).toEqual(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    expect(await row(c.id)).toMatchObject({ pausedScopes: ['wallet:load'], pausedReason: 'foreign_ip', status: 'ACTIVE' });
    expect(await audits(c.id, 'partner.connection.paused')).toHaveLength(1);
    expect(codeOf(await load(c.key))).toBe('scope_paused');
    const read = await me(c.key);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ paused_scopes: ['wallet:load'] });
    // El dueño lo ve en su panel con las IP rechazadas, y lo reanuda con su 2FA.
    const panel = (await admin('GET', v)).json() as { connections: Array<{ pausedBy: string; foreignIps: Array<{ ip: string }> }> };
    expect(panel.connections[0]).toMatchObject({ pausedBy: 'foreign_ip' });
    expect(panel.connections[0]!.foreignIps.map((f) => f.ip).sort()).toEqual(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    expect((await admin('POST', v, `/${c.id}/resume`, { totpCode: TOTP })).statusCode).toBe(200);
    expect((await load(c.key)).statusCode).toBe(200);
  });
});

describe('cada corte vale a la petición siguiente', () => {
  it('anular, caducar, 90 días sin uso, pausa, socio suspendido, techo bajado e IP quitada al socio', async () => {
    const cases: Array<[string, (c: Connected, v: Venue, p: string) => Promise<unknown>, string, 'me' | 'load']> = [
      ['anular', (c, v) => admin('POST', v, `/${c.id}/revoke`), 'api_key_revoked', 'me'],
      ['caducar', (c) => setRow(c.id, { keyExpiresAt: new Date(Date.now() - 1000) }), 'api_key_expired', 'me'],
      [
        '90 días',
        (c) => setRow(c.id, { keyCreatedAt: new Date(Date.now() - 100 * DAY), keyExpiresAt: new Date(Date.now() + DAY), lastUsedAt: new Date(Date.now() - 91 * DAY) }),
        'api_key_suspended',
        'me',
      ],
      ['pausa del dueño', (c, v) => admin('POST', v, `/${c.id}/pause`), 'connection_paused', 'me'],
      ['socio suspendido', (_c, _v, p) => sys((tx) => tx.partner.update({ where: { id: p }, data: { status: 'SUSPENDED' } })), 'partner_suspended', 'me'],
      ['techo bajado', (_c, _v, p) => sys((tx) => tx.partner.update({ where: { id: p }, data: { allowedScopes: ['wallet:balance'] } })), 'scope_missing', 'load'],
      ['IP quitada al socio', (_c, _v, p) => sys((tx) => tx.partner.update({ where: { id: p }, data: { egressIps: ['198.51.100.0/24'] } })), 'ip_not_allowed', 'me'],
    ];
    for (const [name, cut, code, route] of cases) {
      const p = await newPartner();
      const v = await newVenue();
      const c = await connect(v, {}, p);
      const call = () => (route === 'me' ? me(c.key) : load(c.key));
      expect((await call()).statusCode, name).toBe(200);
      await cut(c, v, p);
      expect(codeOf(await call()), name).toBe(code);
    }
  });

  it('dormida: la primera vez queda en la base y el registro; el dueño la reactiva con su 2FA', async () => {
    const v = await newVenue();
    const c = await connect(v, { scopes: ['wallet:balance'], expiresAt: null });
    await setRow(c.id, { keyCreatedAt: new Date(Date.now() - 100 * DAY) });
    expect(codeOf(await me(c.key))).toBe('api_key_suspended');
    expect((await row(c.id))?.keySuspendedAt).toBeInstanceOf(Date);
    expect(await audits(c.id, 'partner.key.suspended')).toHaveLength(1);
    expect(codeOf(await admin('POST', v, `/${c.id}/resume`, {}))).toBe('TOTP_REQUIRED');
    expect((await admin('POST', v, `/${c.id}/resume`, { totpCode: TOTP })).statusCode).toBe(200);
    expect((await me(c.key)).statusCode).toBe(200);
  });

  it('cambiar la clave de una dormida, con solape (la vieja dice replaced) y sin él (la vieja, api_key_rotated)', async () => {
    const v = await newVenue();
    const c = await connect(v, { scopes: ['wallet:balance'], expiresAt: null });
    await setRow(c.id, { keySuspendedAt: new Date() });
    expect(codeOf(await me(c.key))).toBe('api_key_suspended');

    const rotated = await admin('POST', v, `/${c.id}/rotate`, { overlap: '24h', expiresAt: null, delivery: 'copy', totpCode: TOTP });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const second = (rotated.json() as { key: string }).key;
    expect(second).toMatch(PARTNER_KEY_RE);
    expect((await me(second)).json()).toMatchObject({ key: { replaced: false }, id: `pc_${c.id.replace(/-/g, '')}` });
    const old = (await me(c.key)).json() as { key: { replaced: boolean; expires_at: string } };
    expect(old.key.replaced).toBe(true);
    expect(new Date(old.key.expires_at).getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(totpActions).toContain(`partner:rotate:${c.id}`);

    const third = (
      (await admin('POST', v, `/${c.id}/rotate`, { overlap: 'none', expiresAt: null, delivery: 'copy', totpCode: TOTP })).json() as { key: string }
    ).key;
    expect(codeOf(await me(second))).toBe('api_key_rotated');
    expect(codeOf(await me(c.key))).toBe('api_key_rotated');
    expect((await me(third)).statusCode).toBe(200);
    expect(await audits(c.id, 'partner.key.rotated')).toHaveLength(2);
  });

  it('acabado el solape, la vieja dice api_key_rotated (y no cuenta como fallo)', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const next = ((await admin('POST', v, `/${c.id}/rotate`, { overlap: '7d', expiresAt: new Date(Date.now() + 200 * DAY).toISOString(), delivery: 'copy', totpCode: TOTP })).json() as { key: string }).key;
    expect((await me(c.key)).statusCode).toBe(200);
    await setRow(c.id, { prevKeyExpiresAt: new Date(Date.now() - 1000) });
    expect(codeOf(await me(c.key))).toBe('api_key_rotated');
    expect(await redis.keys('np:pauth:key:*')).toEqual([]);
    expect((await me(next)).statusCode).toBe(200);
  });

  it('congelar y descongelar vale sin esperar: money (403 en dinero), all (404) y none', async () => {
    const v = await newVenue();
    const c = await connect(v);
    const actor = { id: v.owner, email: 'super@oxiopay.test' };
    try {
      await saConsole.setApiState(actor, { freeze: 'money', reason: 'Prueba de congelación', totpCode: TOTP });
      expect(codeOf(await load(c.key))).toBe('partner_api_frozen');
      expect((await me(c.key)).statusCode).toBe(200);
      await saConsole.setApiState(actor, { freeze: 'all', reason: 'Prueba de congelación', totpCode: TOTP });
      expect(codeOf(await me(c.key))).toBe('not_found');
      expect((await app.inject({ method: 'GET', url: '/v1/partner/openapi.json', remoteAddress: OK_IP })).statusCode).toBe(404);
    } finally {
      await saConsole.setApiState(actor, { freeze: 'none', reason: 'Fin de la prueba', totpCode: TOTP });
    }
    expect((await load(c.key)).statusCode).toBe(200);
    expect(
      await sys((tx) => tx.auditEvent.count({ where: { action: { in: ['partner.api_frozen', 'partner.api_unfrozen'] }, actorId: v.owner } })),
    ).toBe(3);
  });
});

describe('GET /v1/partner/openapi.json', () => {
  it('es docs/partner-api/openapi.json; apagada o en OxioParty, 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/partner/openapi.json', remoteAddress: OK_IP });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(JSON.parse(readFileSync(join(DOCS, 'openapi.json'), 'utf8')));
    expect(res.headers['cache-control']).toBe('no-store');
    vi.stubEnv('PARTNER_API_ENABLED', 'false');
    expect((await app.inject({ method: 'GET', url: '/v1/partner/openapi.json', remoteAddress: OK_IP })).statusCode).toBe(404);
    expect(codeOf(await app.inject({ method: 'GET', url: '/v1/partner/me', remoteAddress: OK_IP }))).toBe('not_found');
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('EDITION', 'party');
    expect((await app.inject({ method: 'GET', url: '/v1/partner/openapi.json', remoteAddress: OK_IP })).statusCode).toBe(404);
  });
});

describe('el enlace de un uso', () => {
  it('dos POST a la vez enseñan la clave una sola vez; el otro, «no vale» y aviso al dueño', async () => {
    const v = await newVenue();
    const res = await admin('POST', v, '', {
      partnerId,
      scopes: ['wallet:balance'],
      ipAllowlist: [OK_IP],
      expiresAt: null,
      delivery: 'email',
      totpCode: TOTP,
    });
    expect(res.statusCode, res.body).toBe(201);
    const issued = res.json() as { connection: { id: string }; key?: string; claim: { delivered: boolean; sentTo: string } };
    expect(issued.key).toBeUndefined();
    expect(issued.claim).toMatchObject({ delivered: true });
    const mail = mails.at(-1)!;
    const link = /https:\/\/api\.oxiopay\.example\/partner-key\/([A-Za-z0-9_-]{43})/.exec(mail.text ?? '');
    expect(link).not.toBeNull();
    const path = `/partner-key/${link![1]}`;
    const landing = await app.inject({ method: 'GET', url: path, remoteAddress: OK_IP });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers['cache-control']).toBe('no-store');
    expect(landing.headers['referrer-policy']).toBe('no-referrer');
    expect(landing.body).toContain('Ver la clave');
    expect(landing.body).not.toMatch(/oxp_test_[0-9a-f]{48}/);

    const [one, two] = await Promise.all([
      app.inject({ method: 'POST', url: path, remoteAddress: OK_IP, payload: 'ver=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      app.inject({ method: 'POST', url: path, remoteAddress: OK_IP, payload: 'ver=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    ]);
    const shown = [one, two].map((x) => /oxp_test_[0-9a-f]{48}/.exec(x.body)?.[0]).filter(Boolean);
    expect(shown).toHaveLength(1);
    expect([one, two].filter((x) => x.body.includes('Este enlace ya no vale'))).toHaveLength(1);
    expect(await audits(issued.connection.id, 'partner.key.claim_opened')).toHaveLength(1);
    expect(await audits(issued.connection.id, 'partner.key.claim_reopened')).toHaveLength(1);
    expect((await row(issued.connection.id))?.keyClaimSealed).toBeNull();
    expect((await me(shown[0]!)).statusCode).toBe(200);
  });
});
