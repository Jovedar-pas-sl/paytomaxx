// Montaje común de las pruebas de integración de la API de socios (PR 3,
// cargas): el de socios-claves.int.spec.ts y socios-saldo.int.spec.ts (la app
// Nest de verdad con Fastify, prefijo /v1, filtro global, rawBody, los ganchos
// de main.ts, el guard de la clave y las rutas del dueño), Redis de REDIS_URL,
// un 2FA de mentira (vale TOTP y apunta la acción) y un Web Push de mentira
// (guarda lo que se mandaría). Y las filas de siempre: sociedades, locales,
// saldos, fichas, socios y conexiones. Ver test/integration/README.md.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { ForbiddenException, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { Redis } from 'ioredis';
import { vi } from 'vitest';
import { requestTraceId } from '../../src/common/context/trace-id';
import { EmailService } from '../../src/common/email/email.service';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { trustInternalProxy } from '../../src/common/http/client-ip';
import { UNPREFIXED_ROUTES } from '../../src/common/http/unprefixed-routes';
import { httpLoggerOptions } from '../../src/common/logging/logger-options';
import { PrismaService, startRequestTxGate, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { TotpService } from '../../src/modules/auth/totp.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { hashPartnerKey, partnerKeyHint } from '../../src/modules/partner/auth/partner-key';
import { installPartnerBodyLimit, installPartnerReceivedAt, installPartnerUrlCheck } from '../../src/modules/partner/http/partner-hooks';
import { PartnerModule } from '../../src/modules/partner/partner.module';
import { partnerTestHelpersImports } from '../../src/modules/partner/test-helpers/partner-test-helpers.module';
import { WEB_PUSH_ENV } from '../../src/modules/wallets/charge-alert/charge-alert.service';
import { PUSH_SENDER, type PushSender } from '../../src/modules/wallets/charge-alert/push-sender';

export const TOTP = '123456';
export const OK_IP = '203.0.113.9';
export const HOST = 'https://demo-operator.oxiopay.example';
const JWT_SECRET = 'jwt-de-las-pruebas-de-socios-cargas-0123456789';

/** Claves VAPID de mentira (como charge-alert.service.spec.ts): el aviso «sale» por PUSH_SENDER. */
const WEB_PUSH = {
  WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es',
  JWT_SECRET,
};
export const PUSH_P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
export const PUSH_AUTH = Buffer.alloc(16, 1).toString('base64url');

export interface Socios {
  app: NestFastifyApplication;
  prisma: PrismaService;
  cls: ClsService;
  redis: Redis;
  jwt: JwtService;
  audit: AuditService;
  /** Lo que el log de Fastify escribió (cada petición). */
  fastifyLog: string[];
  /** Las acciones que pidieron el 2FA (la prueba de la llave o el código). */
  totpActions: string[];
  /** Los avisos al móvil del cliente: [endpoint, cuerpo en claro]. */
  pushes: Array<{ endpoint: string; payload: Record<string, unknown> }>;
  totp: { assertForUser: ReturnType<typeof vi.fn>; isEnabled: ReturnType<typeof vi.fn> };
  sys: <T>(fn: (tx: TransactionalClient) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

/** La app de socios con las cargas, sobre la base de DATABASE_URL y el Redis de REDIS_URL. */
export async function mountSocios(): Promise<Socios> {
  if (!process.env.REDIS_URL) throw new Error('Las pruebas de socios necesitan REDIS_URL (un Redis de usar y tirar): ver test/integration/README.md.');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const fastifyLog: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, done) {
      fastifyLog.push(chunk.toString('utf8'));
      done();
    },
  });
  const totpActions: string[] = [];
  const totp = {
    assertForUser: vi.fn(async (_user: string, code: string | undefined, action?: string) => {
      if (code !== TOTP) throw new ForbiddenException({ code: 'TOTP_REQUIRED', message: 'Pon el código' });
      if (action) totpActions.push(action);
    }),
    isEnabled: vi.fn(async () => true),
  };
  const pushes: Socios['pushes'] = [];
  const sender: PushSender = async (target, payload) => {
    pushes.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    return { statusCode: 201 };
  };

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useFactory: (cls: ClsService) => new PrismaService(cls as never), inject: [ClsService] },
      { provide: REDIS_CLIENT, useValue: redis },
      AuditService,
      { provide: EmailService, useValue: { isEnabled: () => false, send: vi.fn() } },
      { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: { inc: vi.fn() } } },
      { provide: PUSH_SENDER, useValue: sender },
      { provide: WEB_PUSH_ENV, useValue: WEB_PUSH },
    ],
    exports: [PrismaService, REDIS_CLIENT, AuditService, EmailService, MetricsService, PUSH_SENDER, WEB_PUSH_ENV],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET, NEXT_PUBLIC_API_URL: 'https://demo-api.oxiopay.example', ENCRYPTION_KEK: process.env.ENCRYPTION_KEK })],
      }),
      ClsModule.forRoot({
        global: true,
        middleware: {
          mount: true,
          generateId: true,
          idGenerator: () => randomUUID(),
          setup: (c, req: { url?: string; originalUrl?: string; headers?: Record<string, unknown> }) => {
            c.set('ctx', { traceId: requestTraceId(req, c.getId()) });
            startRequestTxGate(c);
          },
        },
      }),
      InfraModule,
      AuthModule,
      PartnerModule,
      // Las ayudas de la demo, como en app.module.ts: solo si la prueba puso PARTNER_TEST_HELPERS=1.
      ...partnerTestHelpersImports(),
    ],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
    .overrideProvider(TotpService)
    .useValue(totp)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: trustInternalProxy, logger: { ...httpLoggerOptions('trace'), stream: logStream } }),
    { rawBody: true },
  );
  installPartnerBodyLimit(app);
  installPartnerReceivedAt(app);
  installPartnerUrlCheck(app);
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const prisma = app.get(PrismaService);
  const cls = app.get(ClsService);
  // Unas conexiones del pool abiertas ya (las pruebas que hacen varias cosas a la vez).
  await Promise.all(Array.from({ length: 8 }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`));
  const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>) => cls.run(() => prisma.asSystem(fn)) as Promise<T>;
  return {
    app,
    prisma,
    cls,
    redis,
    jwt: app.get(JwtService),
    audit: app.get(AuditService),
    fastifyLog,
    totpActions,
    pushes,
    totp,
    sys,
    close: async () => {
      await app.close();
      await redis.quit();
    },
  };
}

/** Borra lo de Redis de las pruebas (topes, marcas, pausas). */
export async function clearRedis(redis: Redis): Promise<void> {
  for (const pattern of ['np:*', 'nightpay:iprl:*', 'nightpay:userrl:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

// ─── Las filas ────────────────────────────────────────────────────────────

const r = randomUUID().slice(0, 6);
let n = 0;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const shortCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

export interface Seeded {
  venueId: string;
  owner: string;
  manager: string;
}

export async function business(s: Socios, label: string): Promise<string> {
  n += 1;
  return s.sys(async (tx) => (await tx.business.create({ data: { name: `${label} ${r}${n} S.L.`, taxId: `B${Date.now().toString().slice(-7)}${n}` } })).id);
}

export async function venue(s: Socios, label: string, walletGroup: string, businessId: string | null): Promise<Seeded> {
  n += 1;
  return s.sys(async (tx) => {
    const v = await tx.venue.create({ data: { name: `${label} ${r}${n}`, slug: `cargas-${r}-${n}`, walletGroup, businessId } });
    const owner = await tx.user.create({ data: { tenantId: v.id, email: `dueno-${r}${n}@cargas.test`, passwordHash: 'x', role: 'OWNER' } });
    const manager = await tx.user.create({ data: { tenantId: v.id, email: `encargado-${r}${n}@cargas.test`, passwordHash: 'x', role: 'MANAGER' } });
    return { venueId: v.id, owner: owner.id, manager: manager.id };
  });
}

export interface TestWallet {
  id: string;
  qrToken: string;
  shortCode: string;
}

export async function wallet(s: Socios, venueId: string, walletGroup: string | null, over: Record<string, unknown> = {}): Promise<TestWallet> {
  return s.sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: venueId, qrToken: randomBytes(18).toString('base64url'), shortCode: shortCode(), walletGroup, balanceCents: 5000, status: 'ACTIVE', ...over },
    });
    return { id: w.id, qrToken: w.qrToken, shortCode: w.shortCode! };
  });
}

/** Una ficha dada a ese saldo: el `qr` que lee el cajero (su enlace NDEF). */
export async function ficha(s: Socios, walletId: string, venueId: string, over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const token = `it${r}carga${String(n).padStart(6, '0')}`;
  await s.sys((tx) => tx.walletCard.create({ data: { token, walletId, venueId, status: 'ISSUED', ...over } }));
  return `${HOST}/?ficha=${token}`;
}

export async function partner(s: Socios, over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  return s.sys(async (tx) =>
    (
      await tx.partner.create({
        data: {
          name: `Cajeros ${r}${n}`.slice(0, 30),
          legalName: 'Cajeros Demo S.L.',
          taxId: 'B12345678',
          contactEmail: `it-${r}${n}@cajeros.test`,
          allowedScopes: ['wallet:balance', 'wallet:load'],
          egressIps: [],
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

export interface TestConnection {
  id: string;
  key: string;
  tenantId: string;
}

export async function connection(
  s: Socios,
  a: { venueId: string; businessId: string; partnerId: string },
  over: Record<string, unknown> = {},
): Promise<TestConnection> {
  const key = `oxp_test_${randomBytes(24).toString('hex')}`;
  const row = await s.sys((tx) =>
    tx.partnerConnection.create({
      data: {
        tenantId: a.venueId,
        partnerId: a.partnerId,
        businessId: a.businessId,
        collectionModel: 'VENUE_COLLECTS',
        channel: 'IN_VENUE',
        scopes: ['wallet:balance', 'wallet:load'],
        keyMode: 'test',
        keyHash: hashPartnerKey(key),
        keyHint: partnerKeyHint(key),
        keyCreatedAt: new Date(),
        keyExpiresAt: new Date(Date.now() + 300 * 86_400_000),
        createdById: randomUUID(),
        ...over,
      },
    }),
  );
  return { id: row.id, key, tenantId: a.venueId };
}

/** El JWT del dueño o del encargado de un local (las rutas del panel). */
export function staffToken(s: Socios, user: string, tenantId: string, role: 'OWNER' | 'MANAGER'): Promise<string> {
  return s.jwt.signAsync({ sub: user, email: `${user}@cargas.test`, role, tenantId, venueSlug: 'x' }, { expiresIn: 3_600 });
}

/** Una clave nueva de Idempotency-Key (8–64, con 4 al azar al final, como la guía). */
export function newKey(prefix = 'ATM0042'): string {
  n += 1;
  return `${prefix}-${r}-${String(n).padStart(6, '0')}-${randomBytes(2).toString('hex').toUpperCase()}`;
}
