// Integración (Postgres y Redis de verdad): la API de socios, PR 2 (partes A y B).
// POST /v1/partner/wallet/balance (identificar un saldo y leer su saldo) y el
// código del móvil de la página del saldo (POST /w/:token/live-code). La app
// Nest con el arranque de socios-claves.int.spec.ts más el controlador del
// código con sus proveedores y, para la parte B, el de la página del saldo
// (GET /w/:token, con su «Pagar o recargar en otro sistema»). Una clave oxp_test_ del local A (sociedad X,
// grupo G). Redis es el de REDIS_URL. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { ForbiddenException, Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD, ModuleRef } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { Redis } from 'ioredis';
import { requestTraceId } from '../../src/common/context/trace-id';
import { EmailService } from '../../src/common/email/email.service';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { trustInternalProxy } from '../../src/common/http/client-ip';
import { httpLoggerOptions } from '../../src/common/logging/logger-options';
import { UNPREFIXED_ROUTES } from '../../src/common/http/unprefixed-routes';
import * as sentry from '../../src/common/observability/sentry';
import { PrismaService, startRequestTxGate } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { TotpService } from '../../src/modules/auth/totp.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { hashPartnerKey, partnerKeyHint } from '../../src/modules/partner/auth/partner-key';
import { installPartnerBodyLimit, installPartnerUrlCheck } from '../../src/modules/partner/http/partner-hooks';
import { PartnerModule } from '../../src/modules/partner/partner.module';
import { PartnerWalletRefs } from '../../src/modules/partner/wallet/partner-wallet-ref';
import { PublicWalletLiveCodeController } from '../../src/modules/wallets/public-wallet-live-code.controller';
import { PublicWalletController } from '../../src/modules/wallets/public-wallet.controller';
import { GoogleWalletService } from '../../src/modules/wallets/google-wallet/google-wallet.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletLiveCodeModule } from '../../src/modules/wallets/wallet-live-code.module';
import { WalletLiveCodeService } from '../../src/modules/wallets/wallet-live-code.service';
import { WalletPasskeysService } from '../../src/modules/wallets/wallet-passkeys.service';

vi.mock('../../src/common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/common/observability/sentry')>()),
  reportError: vi.fn(),
}));

const r = randomUUID().slice(0, 6);
const JWT_SECRET = 'jwt-de-las-pruebas-de-socios-saldo-0123456789';
const COOKIE_SECRET = 'cookies-de-las-pruebas-de-socios-saldo-012345';
const HOST = 'https://demo-operator.oxiopay.example';

if (!process.env.REDIS_URL) {
  throw new Error('socios-saldo necesita REDIS_URL (un Redis de usar y tirar): ver test/integration/README.md.');
}
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });

/** Todo lo que Fastify escribe en su log (cada petición). */
const fastifyLog: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _enc, done) {
    fastifyLog.push(chunk.toString('utf8'));
    done();
  },
});

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: (cls: ClsService) => new PrismaService(cls as never), inject: [ClsService] },
    { provide: REDIS_CLIENT, useValue: redis },
    AuditService,
    { provide: EmailService, useValue: { isEnabled: () => false, send: vi.fn() } },
    { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: { inc: vi.fn() } } },
  ],
  exports: [PrismaService, REDIS_CLIENT, AuditService, EmailService, MetricsService],
})
class InfraModule {}

const totp = {
  assertForUser: vi.fn(async () => {
    throw new ForbiddenException({ code: 'TOTP_REQUIRED' });
  }),
  isEnabled: async () => true,
};

let app: NestFastifyApplication;
let prisma: PrismaService;
let cls: ClsService;
let charges: WalletChargesService;
let n = 0;

type Tx = Parameters<Parameters<PrismaService['asSystem']>[0]>[0];
const sys = <T>(fn: (tx: Tx) => Promise<T>) => cls.run(() => prisma.asSystem(fn)) as Promise<T>;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const shortCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
const linkToken = () => randomBytes(18).toString('base64url');

interface Wallet {
  id: string;
  qrToken: string;
  shortCode: string;
}

// Los locales: A (la clave), A2 (mismo grupo y sociedad), A3 (mismo grupo, otra
// sociedad), A4 (mismo grupo, sin sociedad) y B (otro grupo, misma sociedad).
const G = `gsaldo-${r}`;
const V: Record<'A' | 'A2' | 'A3' | 'A4' | 'B', string> = { A: '', A2: '', A3: '', A4: '', B: '' };
let X = '';
let ownerA = '';
let partnerId = '';
let connId = '';
let KEY = '';

async function venue(name: string, walletGroup: string, businessId: string | null): Promise<string> {
  n += 1;
  return sys(async (tx) => (await tx.venue.create({ data: { name: `${name} ${r}`, slug: `saldo-${r}-${n}`, walletGroup, businessId } })).id);
}

async function wallet(venueId: string, over: Record<string, unknown> = {}): Promise<Wallet> {
  const group = venueId === V.B ? `gotro-${r}` : G;
  return sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: venueId, qrToken: linkToken(), shortCode: shortCode(), walletGroup: group, balanceCents: 5000, status: 'ACTIVE', ...over },
    });
    return { id: w.id, qrToken: w.qrToken, shortCode: w.shortCode! };
  });
}

/** Una ficha (por defecto dada a ese saldo): su código, el del enlace grabado. */
async function ficha(walletId: string | null, venueId: string, over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const token = `it${r}ficha${String(n).padStart(6, '0')}`;
  await sys((tx) => tx.walletCard.create({ data: { token, walletId, venueId, status: 'ISSUED', ...over } }));
  return token;
}
const fichaUrl = (token: string) => `${HOST}/?ficha=${token}`;

async function newConnection(venueId: string, businessId: string, over: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const key = `oxp_test_${randomBytes(24).toString('hex')}`;
  const row = await sys((tx) =>
    tx.partnerConnection.create({
      data: {
        tenantId: venueId,
        partnerId,
        businessId,
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
  return { id: row.id, key };
}

function balance(qr: string, opts: { nfcUid?: string; key?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/partner/wallet/balance',
    headers: { authorization: `Bearer ${opts.key ?? KEY}`, ...opts.headers },
    payload: (opts.body ?? { qr, ...(opts.nfcUid !== undefined ? { nfc_uid: opts.nfcUid } : {}) }) as object,
  });
}

/** El código del móvil, como lo pide la página del saldo. */
async function liveCode(w: Pick<Wallet, 'qrToken'>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/w/${w.qrToken}/live-code` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { code: string }).code;
}

const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
const withoutRequestId = (res: { json: () => unknown }) => {
  const { request_id: _id, ...rest } = res.json() as Record<string, unknown>;
  return rest;
};
const maxAuditId = async () => (await sys((tx) => tx.auditEvent.aggregate({ _max: { id: true } })))._max.id ?? 0n;
const auditsSince = (since: bigint, where: Record<string, unknown> = {}) =>
  sys((tx) => tx.auditEvent.findMany({ where: { id: { gt: since }, ...where }, orderBy: { id: 'asc' } }));

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
        load: [() => ({ JWT_SECRET, COOKIE_SECRET, NEXT_PUBLIC_API_URL: 'https://api.oxiopay.example', ENCRYPTION_KEK: process.env.ENCRYPTION_KEK })],
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
      WalletLiveCodeModule,
    ],
    controllers: [PublicWalletLiveCodeController, PublicWalletController],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      {
        provide: WalletChargesService,
        useFactory: (p: PrismaService, a: AuditService, ref: ModuleRef, t: TotpService, c: ClsService, live: WalletLiveCodeService) =>
          new WalletChargesService(p, a, ref, t, c as never, undefined, live),
        inject: [PrismaService, AuditService, ModuleRef, TotpService, ClsService, WalletLiveCodeService],
      },
      { provide: WalletPasskeysService, useFactory: (p: PrismaService) => new WalletPasskeysService(p, redis), inject: [PrismaService] },
      // La página del saldo (parte B): sin Google Wallet ni «Recargar».
      { provide: GoogleWalletService, useValue: { enabled: false } },
      { provide: WalletTopUpService, useValue: { options: async () => null, paidProof: async () => null } },
    ],
  })
    .overrideProvider(TotpService)
    .useValue(totp)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: trustInternalProxy, logger: { ...httpLoggerOptions('trace'), stream: logStream } }),
    { rawBody: true },
  );
  installPartnerBodyLimit(app);
  installPartnerUrlCheck(app);
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  cls = app.get(ClsService);
  charges = app.get(WalletChargesService);
  await Promise.all([0, 1, 2, 3].map(() => prisma.$executeRaw`SELECT pg_sleep(0.2)`));

  await sys(async (tx) => {
    X = (await tx.business.create({ data: { name: `Sociedad X ${r} S.L.`, taxId: `BX${Date.now().toString().slice(-7)}` } })).id;
  });
  const Y = await sys(async (tx) => (await tx.business.create({ data: { name: `Sociedad Y ${r} S.L.`, taxId: `BY${Date.now().toString().slice(-7)}` } })).id);
  V.A = await venue('Sala A', G, X);
  V.A2 = await venue('Sala A2', G, X);
  V.A3 = await venue('Sala A3', G, Y);
  V.A4 = await venue('Sala A4', G, null);
  V.B = await venue('Sala B', `gotro-${r}`, X);
  ownerA = await sys(async (tx) => (await tx.user.create({ data: { tenantId: V.A, email: `dueno-${r}@saldo.test`, passwordHash: 'x', role: 'OWNER' } })).id);
  partnerId = await sys(async (tx) =>
    (
      await tx.partner.create({
        data: {
          name: `Cajeros Saldo ${r}`.slice(0, 30),
          legalName: 'Cajeros Demo S.L.',
          taxId: 'B12345678',
          contactEmail: `it-${r}@cajeros.test`,
          allowedScopes: ['wallet:balance', 'wallet:load'],
          egressIps: [],
          kybCheckedAt: new Date(),
          dataRole: 'PROCESSOR_OF_VENUE',
          dpaSignedAt: new Date(),
          dpaVersion: 'v1',
          dataCountry: 'ES',
          createdById: randomUUID(),
        },
      })
    ).id,
  );
  const conn = await newConnection(V.A, X);
  connId = conn.id;
  KEY = conn.key;
});

afterAll(async () => {
  await app?.close();
  await redis.quit();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await clearRedis();
});

describe('1. alcance: antes que todo, y fuera el 404 de siempre', () => {
  it('fichas y códigos de A y de A2 (mismo grupo y sociedad): 200', async () => {
    for (const home of [V.A, V.A2]) {
      const w = await wallet(home, { balanceCents: 4200 });
      const byFicha = await balance(fichaUrl(await ficha(w.id, home)));
      expect(byFicha.statusCode, byFicha.body).toBe(200);
      expect(byFicha.json()).toEqual({ object: 'wallet_balance', available: 4200, currency: 'EUR', livemode: false });
      const byCode = await balance(await liveCode(w));
      expect(byCode.statusCode, byCode.body).toBe(200);
      expect(byCode.json()).toMatchObject({ available: 4200 });
    }
  });

  it('A3 (otra sociedad), A4 (sin sociedad), B (otro grupo) y un regalo de A2 (sin grupo): 404 con el cuerpo de «no existe»', async () => {
    const unknown = withoutRequestId(await balance(fichaUrl(`it${r}fichaInexistente0`)));
    expect(unknown).toMatchObject({ status: 404, code: 'wallet_not_found' });
    const outside = [
      await wallet(V.A3),
      await wallet(V.A4),
      await wallet(V.B),
      await wallet(V.A2, { walletGroup: null }), // el saldo de un regalo: de ese local, sin grupo
    ];
    for (const w of outside) {
      const res = await balance(fichaUrl(await ficha(w.id, V.A)));
      expect(res.statusCode).toBe(404);
      expect(withoutRequestId(res)).toEqual(unknown);
      const byCode = await balance(await liveCode(w));
      expect(byCode.statusCode).toBe(404);
      expect(withoutRequestId(byCode)).toEqual(unknown);
    }
  });

  it('fuera del alcance, una ficha perdida, copiada o de un saldo bloqueado: 404 y ninguna fila nueva en audit_events', async () => {
    const since = await maxAuditId();
    const cases: Array<{ qr: string; nfcUid?: string }> = [];
    for (const home of [V.A3, V.B]) {
      cases.push({ qr: fichaUrl(await ficha((await wallet(home)).id, home, { status: 'LOST' })) });
      cases.push({ qr: fichaUrl(await ficha((await wallet(home)).id, home, { uid: '04A1B2C3D4E5F6' })), nfcUid: '04FFFFFFFFFFFF' });
      cases.push({ qr: fichaUrl(await ficha((await wallet(home, { blockedAt: new Date() })).id, home)) });
      cases.push({ qr: fichaUrl(await ficha((await wallet(home, { status: 'REFUNDED' })).id, home)) });
    }
    for (const c of cases) {
      const res = await balance(c.qr, { nfcUid: c.nfcUid });
      expect(res.statusCode).toBe(404);
      expect(codeOf(res)).toBe('wallet_not_found');
    }
    expect(await auditsSince(since)).toEqual([]);
  });
});

describe('2. dentro del alcance: la ficha, su número de serie y el saldo', () => {
  it('perdida 409 ficha_lost, bloqueada 409 ficha_blocked; del stock, devuelta o sustituida 404; ACTIVE antigua 200', async () => {
    const w = await wallet(V.A);
    expect(codeOf(await balance(fichaUrl(await ficha(w.id, V.A, { status: 'LOST' }))))).toBe('ficha_lost');
    expect(codeOf(await balance(fichaUrl(await ficha(w.id, V.A, { status: 'BLOCKED' }))))).toBe('ficha_blocked');
    for (const over of [{ status: 'STOCK' }, { status: 'RETURNED' }]) {
      const res = await balance(fichaUrl(await ficha(null, V.A, over)));
      expect([res.statusCode, codeOf(res)]).toEqual([404, 'wallet_not_found']);
    }
    // La sustituida queda perdida y sin saldo.
    expect(codeOf(await balance(fichaUrl(await ficha(null, V.A, { status: 'LOST' }))))).toBe('wallet_not_found');
    expect((await balance(fichaUrl(await ficha(w.id, V.A, { status: 'ACTIVE' })))).statusCode).toBe(200);
  });

  it('el número de serie: igual con «:» y en minúsculas 200; distinto 409 con un registro (el segundo, sin); sin guardado 200 y no se guarda', async () => {
    const w = await wallet(V.A);
    const withUid = await ficha(w.id, V.A, { uid: '04A1B2C3D4E5F6' });
    expect((await balance(fichaUrl(withUid), { nfcUid: '04:a1:b2:c3:d4:e5:f6' })).statusCode).toBe(200);
    const since = await maxAuditId();
    const copy = await balance(fichaUrl(withUid), { nfcUid: '04-11-22-33-44-55-66' });
    expect([copy.statusCode, codeOf(copy)]).toEqual([409, 'ficha_copy_suspected']);
    const again = await balance(fichaUrl(withUid), { nfcUid: '04 11 22 33 44 55 66' });
    expect(codeOf(again)).toBe('ficha_copy_suspected');
    const rows = await auditsSince(since);
    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: withUid } }));
    expect(rows.map((a) => ({ action: a.action, tenantId: a.tenantId, targetId: a.targetId, payload: a.payload }))).toEqual([
      {
        action: 'wallet.card_copy_suspected',
        tenantId: V.A,
        targetId: w.id,
        payload: { cardId: card.id, connectionId: connId, keyHint: partnerKeyHint(KEY), name: `Cajeros Saldo ${r}`.slice(0, 30), code: `${w.shortCode.slice(0, 3)}-${w.shortCode.slice(3)}` },
      },
    ]);
    expect(JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/0411223344|04-11-22|ficha=/i);
    // Una ficha dada por saldo: otro saldo para la ficha sin número guardado.
    const noUid = await ficha((await wallet(V.A)).id, V.A);
    expect((await balance(fichaUrl(noUid), { nfcUid: '04A1B2C3D4E5F6' })).statusCode).toBe(200);
    expect((await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: noUid } }))).uid).toBeNull();
  });

  it('el saldo: bloqueado 409 wallet_blocked; REFUNDED o EXPIRED 409 wallet_closed; DEPLETED 200 con 0; sumado a otro, el de destino', async () => {
    expect(codeOf(await balance(fichaUrl(await ficha((await wallet(V.A, { blockedAt: new Date() })).id, V.A))))).toBe('wallet_blocked');
    for (const status of ['REFUNDED', 'EXPIRED'] as const) {
      expect(codeOf(await balance(fichaUrl(await ficha((await wallet(V.A, { status, balanceCents: 0 })).id, V.A))))).toBe('wallet_closed');
    }
    const empty = await balance(fichaUrl(await ficha((await wallet(V.A, { status: 'DEPLETED', balanceCents: 0 })).id, V.A)));
    expect([empty.statusCode, empty.json()]).toEqual([200, { object: 'wallet_balance', available: 0, currency: 'EUR', livemode: false }]);
    const target = await wallet(V.A, { balanceCents: 7300 });
    const merged = await wallet(V.A, { balanceCents: 0, mergedIntoId: target.id });
    const res = await balance(fichaUrl(await ficha(merged.id, V.A)));
    expect([res.statusCode, (res.json() as { available: number }).available]).toEqual([200, 7300]);
  });
});

describe('3. el código del móvil', () => {
  it('/w/<enlace>/live-code y luego POST /wallet/balance: 200; con nfc_uid, 422; uno inventado, live_code_invalid', async () => {
    const w = await wallet(V.A, { balanceCents: 1500 });
    const code = await liveCode(w);
    expect((await balance(code)).json()).toEqual({ object: 'wallet_balance', available: 1500, currency: 'EUR', livemode: false });
    // Leer el saldo no lo gasta.
    expect((await balance(code)).statusCode).toBe(200);
    const withUid = await balance(code, { nfcUid: '04A1B2C3D4E5F6', headers: { 'accept-language': 'es' } });
    expect([withUid.statusCode, codeOf(withUid)]).toEqual([422, 'validation_failed']);
    expect(withUid.json()).toMatchObject({ param: 'nfc_uid', detail: 'nfc_uid: solo va con el enlace de una ficha leída por NFC.' });
    const invented = await balance('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9');
    expect([invented.statusCode, codeOf(invented)]).toEqual([422, 'live_code_invalid']);
  });

  it('tras un enlace nuevo (relink) el código ya no vale, y el enlace viejo da 404', async () => {
    const w = await wallet(V.A);
    const code = await liveCode(w);
    await cls.run(async () => {
      cls.set('ctx', { tenantId: V.A, traceId: 't-relink' });
      await charges.relink({ userId: ownerA, role: 'OWNER', tenantId: V.A } as never, w.id);
    });
    expect(codeOf(await balance(code))).toBe('live_code_invalid');
    expect((await app.inject({ method: 'POST', url: `/w/${w.qrToken}/live-code` })).statusCode).toBe(404);
  });

  it('tras sumar su recarga a otro saldo (mergeInto), el código de la recarga ya no vale y no da otro', async () => {
    const recarga = await wallet(V.A, { balanceCents: 2000 });
    const target = await wallet(V.A, { balanceCents: 1000 });
    const code = await liveCode(recarga);
    await cls.run(() => charges.mergeInto(recarga.id, target.id));
    expect(codeOf(await balance(code))).toBe('live_code_invalid');
    const again = await app.inject({ method: 'POST', url: `/w/${recarga.qrToken}/live-code` });
    expect([again.statusCode, codeOf(again)]).toEqual([409, 'WALLET_CLOSED']);
  });
});

describe('4. lo que se rechaza por su forma', () => {
  it.each([
    ['https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001', 'wallet_ref_not_accepted', 'wallet_pass'],
    ['https://demo-api.oxiopay.example/w/demoPrivateLink000000001', 'wallet_ref_not_accepted', 'private_link'],
    ['NPF:K7Q4M2:demoReceptionProof0001', 'wallet_ref_not_accepted', 'reception_qr'],
    ['K7Q4M2', 'wallet_ref_not_accepted', 'short_code'],
    ['https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001', 'wallet_ref_not_accepted', 'charge_link'],
    ['https://demo-api.oxiopay.example/w/a/demoActivationLink000001', 'wallet_ref_not_accepted', 'other_link'],
    ['https://example.org/carta', 'wallet_ref_unrecognized', undefined],
  ])('%s → 422 %s %s', async (qr, code, reason) => {
    const res = await balance(qr);
    expect([res.statusCode, codeOf(res)]).toEqual([422, code]);
    expect((res.json() as { reason?: string }).reason).toBe(reason);
  });

  it('el enlace privado de un saldo de A: un partner.master_link_submitted sin el enlace (el segundo, ninguno)', async () => {
    const w = await wallet(V.A);
    const since = await maxAuditId();
    const first = await balance(`https://api.oxiopay.example/w/${w.qrToken}`);
    expect(first.json()).toMatchObject({ code: 'wallet_ref_not_accepted', reason: 'private_link' });
    await balance(`https://api.oxiopay.example/w/${w.qrToken}/state`);
    const rows = await auditsSince(since);
    expect(rows.map((a) => [a.action, a.tenantId, a.targetType, a.targetId])).toEqual([['partner.master_link_submitted', V.A, 'ClientWallet', w.id]]);
    expect(rows[0]!.payload).toMatchObject({ connectionId: connId, keyHint: partnerKeyHint(KEY), code: `${w.shortCode.slice(0, 3)}-${w.shortCode.slice(3)}` });
    expect((rows[0]!.payload as { linkRef: string }).linkRef).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(w.qrToken);
  });

  it('el enlace privado de B, el de una recarga sumada o uno inventado: ningún registro', async () => {
    const ofB = await wallet(V.B);
    const target = await wallet(V.A);
    const merged = await wallet(V.A, { mergedIntoId: target.id, balanceCents: 0 });
    const since = await maxAuditId();
    for (const token of [ofB.qrToken, merged.qrToken, linkToken()]) {
      expect(codeOf(await balance(`https://api.oxiopay.example/w/${token}`))).toBe('wallet_ref_not_accepted');
    }
    expect(await auditsSince(since)).toEqual([]);
  });
});

describe('5. topes y permisos', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());
  /** A los 5 s de un minuto nuevo (las llamadas caben en una ventana). */
  const freshMinute = (offset: number) => vi.setSystemTime(new Date(Math.floor(Date.now() / 60_000 + offset) * 60_000 + 5_000));

  it('la 13.ª lectura del minuto de un saldo, 429 con un partner.limit_exceeded sin el qr; otro saldo, 200', async () => {
    freshMinute(1);
    const w = await wallet(V.A);
    const qr = fichaUrl(await ficha(w.id, V.A));
    for (let i = 0; i < 12; i += 1) expect((await balance(qr)).statusCode).toBe(200);
    const since = await maxAuditId();
    const limited = await balance(qr);
    expect([limited.statusCode, codeOf(limited)]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBe(55);
    const rows = await auditsSince(since);
    expect(rows.map((a) => [a.action, a.targetId, (a.payload as { limit: string }).limit])).toEqual([['partner.limit_exceeded', w.id, 'balance_minute']]);
    expect(JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/ficha=|it.*ficha0/);
    expect((await balance(fichaUrl(await ficha((await wallet(V.A)).id, V.A)))).statusCode).toBe(200);
  });

  it('el 31.º texto raro del minuto, 429, mientras la ficha y el código siguen', async () => {
    freshMinute(2);
    const w = await wallet(V.A);
    const code = await liveCode(w);
    for (let i = 0; i < 30; i += 1) expect(codeOf(await balance(`https://example.org/carta-${i}`))).toBe('wallet_ref_unrecognized');
    expect(codeOf(await balance('K7Q4M2'))).toBe('rate_limited');
    expect((await balance(fichaUrl(await ficha(w.id, V.A)))).statusCode).toBe(200);
    expect((await balance(code)).statusCode).toBe(200);
  });

  it('sin wallet:balance, scope_missing; con wallet:balance en pausa, scope_paused; con solo wallet:load en pausa, 200', async () => {
    freshMinute(3);
    const qr = fichaUrl(await ficha((await wallet(V.A)).id, V.A));
    const loadOnly = await newConnection(V.A2, X, { scopes: ['wallet:load'] });
    expect((await balance(qr, { key: loadOnly.key })).json()).toMatchObject({ code: 'scope_missing', required_scope: 'wallet:balance' });
    // Puesto en la base: en el piloto ninguna pausa automática pausa wallet:balance.
    await sys((tx) => tx.partnerConnection.update({ where: { id: connId }, data: { pausedScopes: ['wallet:balance'] } }));
    expect(codeOf(await balance(qr))).toBe('scope_paused');
    await sys((tx) => tx.partnerConnection.update({ where: { id: connId }, data: { pausedScopes: ['wallet:load'] } }));
    expect((await balance(qr)).statusCode).toBe(200);
    await sys((tx) => tx.partnerConnection.update({ where: { id: connId }, data: { pausedScopes: [] } }));
  });
});

describe('6. la respuesta y la redacción', () => {
  it('solo object, available, currency y livemode, con Request-Id y no-store; ni el qr ni el UID en ningún detail', async () => {
    const w = await wallet(V.A);
    const token = await ficha(w.id, V.A, { uid: '04A1B2C3D4E5F6' });
    const ok = await balance(fichaUrl(token), { nfcUid: '04A1B2C3D4E5F6', headers: { 'x-request-id': 'atm0042-req-1' } });
    expect(Object.keys(ok.json() as object).sort()).toEqual(['available', 'currency', 'livemode', 'object']);
    expect(ok.headers['request-id']).toBe('atm0042-req-1');
    expect(ok.headers['cache-control']).toBe('no-store');
    const bodies = [
      await balance(fichaUrl(token), { nfcUid: '04BBBBBBBBBBBB' }),
      await balance(`https://api.oxiopay.example/w/${w.qrToken}`, { headers: { 'accept-language': 'es' } }),
      await balance('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9', { nfcUid: '04BBBBBBBBBBBB' }),
      await balance('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9'),
      await balance(fichaUrl(token), { body: { qr: fichaUrl(token), extra: 1 } }),
    ].map((res) => res.body);
    for (const body of bodies) {
      expect(body).not.toMatch(new RegExp(`${token}|${w.qrToken}|04BBBBBBBBBBBB|K3J7Q2M9X4T8R6V1N5B0C2D7F9`));
    }
  });

  it('un 200 mueve lastUsedAt y GET /me no', async () => {
    const old = new Date(Date.now() - 3_600_000);
    await sys((tx) => tx.partnerConnection.update({ where: { id: connId }, data: { lastUsedAt: old } }));
    const me = await app.inject({ method: 'GET', url: '/v1/partner/me', headers: { authorization: `Bearer ${KEY}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect((await sys((tx) => tx.partnerConnection.findUniqueOrThrow({ where: { id: connId } }))).lastUsedAt).toEqual(old);
    expect((await balance(fichaUrl(await ficha((await wallet(V.A)).id, V.A)))).statusCode).toBe(200);
    expect((await sys((tx) => tx.partnerConnection.findUniqueOrThrow({ where: { id: connId } }))).lastUsedAt!.getTime()).toBeGreaterThan(old.getTime());
  });

  it('una ficha con UID, un enlace privado, un OXC1: y un 500 forzado en resolve no dejan rastro en el log, Sentry ni audit_events', async () => {
    const reportError = vi.mocked(sentry.reportError);
    reportError.mockClear();
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture)),
      ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((m) => vi.spyOn(Logger, m).mockImplementation(capture)),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture)),
    ];
    fastifyLog.length = 0;
    const since = await maxAuditId();
    const w = await wallet(V.A);
    const token = await ficha(w.id, V.A, { uid: '04A1B2C3D4E5F6' });
    const code = await liveCode(w);
    const secrets = [token, w.qrToken, code.slice(5), '04A1B2C3D4E5F6', '04CCCCCCCCCCCC'];
    try {
      expect((await balance(fichaUrl(token), { nfcUid: '04A1B2C3D4E5F6' })).statusCode).toBe(200);
      expect(codeOf(await balance(fichaUrl(token), { nfcUid: '04CCCCCCCCCCCC' }))).toBe('ficha_copy_suspected');
      expect(codeOf(await balance(`https://api.oxiopay.example/w/${w.qrToken}`))).toBe('wallet_ref_not_accepted');
      expect((await balance(code)).statusCode).toBe(200);
      // Un fallo de la base con la consulta en su mensaje (como los de Prisma).
      const refs = app.get(PartnerWalletRefs);
      const boom = Object.assign(new Error(`Invalid invocation: where { token: "${token}", uid: "04CCCCCCCCCCCC" }`), { name: 'PrismaClientValidationError' });
      vi.spyOn(refs, 'resolve').mockRejectedValueOnce(boom);
      const failed = await balance(fichaUrl(token), { nfcUid: '04CCCCCCCCCCCC' });
      expect([failed.statusCode, codeOf(failed)]).toEqual([500, 'internal_error']);
      expect(failed.body).not.toContain(token);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(reportError).toHaveBeenCalledTimes(1);
    const sentryText = JSON.stringify(reportError.mock.calls.map(([e, ctx]) => [(e as Error).message, (e as Error).stack, ctx]));
    const auditText = JSON.stringify(await auditsSince(since), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    const everything = [...logged, ...fastifyLog, sentryText, auditText].join('\n');
    expect(fastifyLog.length).toBeGreaterThan(0);
    expect(logged.some((l) => /fallo inesperado/.test(l))).toBe(true);
    for (const secret of secrets) expect(everything, secret).not.toContain(secret);
  });
});

describe('parte B: la página del saldo trae «Pagar o recargar en otro sistema» solo si una conexión lo alcanza', () => {
  const page = async (w: Pick<Wallet, 'qrToken'>) => {
    const res = await app.inject({ method: 'GET', url: `/w/${w.qrToken}` });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return res.body;
  };
  const hasBlock = (html: string) => html.includes('id="lcCard"') && html.includes('\\"liveCode\\":true');

  it('un saldo de A o A2 (la conexión de A lo alcanza): sí, ACTIVE o vacío; de A3 (otra sociedad), A4 o B: no', async () => {
    expect(hasBlock(await page(await wallet(V.A)))).toBe(true);
    expect(hasBlock(await page(await wallet(V.A2)))).toBe(true);
    expect(hasBlock(await page(await wallet(V.A, { status: 'DEPLETED', balanceCents: 0 })))).toBe(true);
    for (const home of [V.A3, V.A4, V.B]) {
      const html = await page(await wallet(home));
      expect(html).not.toContain('lcCard');
      expect(html).not.toContain('/live-code');
    }
  });

  it('una conexión anulada, en pausa, dormida, caducada o sin wallet:balance ni wallet:load no lo trae; una que vale, sí', async () => {
    const w = await wallet(V.B);
    const conn = await newConnection(V.B, X, { status: 'REVOKED' });
    try {
      expect(hasBlock(await page(w))).toBe(false);
      const set = (data: Record<string, unknown>) => sys((tx) => tx.partnerConnection.update({ where: { id: conn.id }, data }));
      for (const data of [
        { status: 'PAUSED' },
        { status: 'ACTIVE', keySuspendedAt: new Date() },
        { keySuspendedAt: null, keyExpiresAt: new Date(Date.now() - 1000) },
        { keyExpiresAt: new Date(Date.now() + 100 * 86_400_000), keyCreatedAt: new Date(Date.now() - 91 * 86_400_000) },
        { keyCreatedAt: new Date(), scopes: ['charges:read'] },
      ]) {
        await set(data);
        expect(hasBlock(await page(w)), JSON.stringify(data)).toBe(false);
      }
      await set({ scopes: ['wallet:load'] });
      expect(hasBlock(await page(w))).toBe(true);
      // Un saldo sumado a otro: nunca.
      const target = await wallet(V.B);
      const merged = await wallet(V.B, { status: 'DEPLETED', balanceCents: 0, mergedIntoId: target.id });
      expect(hasBlock(await page(merged))).toBe(false);
    } finally {
      await sys((tx) => tx.partnerConnection.delete({ where: { id: conn.id } }));
    }
  });

  it('con la API apagada, ni el bloque ni el código (POST /w/:token/live-code, 404)', async () => {
    const w = await wallet(V.A);
    vi.stubEnv('PARTNER_API_ENABLED', 'false');
    try {
      const html = await page(w);
      expect(html).not.toContain('lcCard');
      expect((await app.inject({ method: 'POST', url: `/w/${w.qrToken}/live-code` })).statusCode).toBe(404);
    } finally {
      vi.stubEnv('PARTNER_API_ENABLED', 'true');
    }
    expect(hasBlock(await page(w))).toBe(true);
  });
});
