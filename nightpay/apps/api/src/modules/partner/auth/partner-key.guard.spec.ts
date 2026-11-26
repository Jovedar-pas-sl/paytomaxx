import 'reflect-metadata';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { PARTNER_ROUTES, type PartnerRouteDef } from '@nightpay/contracts';
import { createFakeRedis, type FakeRedis } from '../../auth/testing/fake-redis';
import { PARTNER_ROUTE } from '../http/partner-route.decorator';
import { PartnerHttpException } from '../http/partner-problem';
import { PAUTH_LIMITS, PartnerAuthLimiter } from './partner-auth-limiter';
import { PartnerForeignIpService } from './partner-foreign-ip';
import { PartnerKeyGuard } from './partner-key.guard';
import { hashPartnerKey } from './partner-key';
import { PartnerRateLimiter } from './partner-rate-limit';

const KEY = `oxp_test_${'ab12'.repeat(12)}`;
const NOW = new Date('2026-12-05T22:00:00Z');
const DAY = 86_400_000;
const MONEY_ROUTE: PartnerRouteDef = {
  ...PARTNER_ROUTES.getConnection,
  method: 'POST',
  path: '/prueba/dinero',
  operationId: 'pruebaDinero',
  scopes: ['wallet:load'],
  money: true,
  errorResponses: { '403': 'ForbiddenMoney' },
};

type Row = Record<string, unknown> & { partner: Record<string, unknown>; venue: Record<string, unknown> };

function connection(over: Partial<Row> = {}): Row {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
    partnerId: 'bbbbbbbb-0000-0000-0000-000000000001',
    businessId: 'cccccccc-0000-0000-0000-000000000001',
    status: 'ACTIVE',
    collectionModel: 'VENUE_COLLECTS',
    channel: 'IN_VENUE',
    pausedScopes: [],
    pausedReason: null,
    scopes: ['wallet:balance', 'wallet:load'],
    keyMode: 'test',
    keyHash: hashPartnerKey(KEY),
    keyHint: 'oxp_test_…ab12',
    keyCreatedAt: new Date(NOW.getTime() - 10 * DAY),
    keyExpiresAt: new Date(NOW.getTime() + 300 * DAY),
    prevKeyHash: null,
    prevKeyExpiresAt: null,
    keySuspendedAt: null,
    keyResumedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    ipAllowlist: ['203.0.113.9'],
    loadPerOpMaxCents: 30000,
    loadWalletDayMaxCents: 60000,
    loadNightMaxCents: 500000,
    partner: { id: 'bbbbbbbb-0000-0000-0000-000000000001', name: 'Cajeros Demo', status: 'ACTIVE', allowedScopes: ['wallet:balance', 'wallet:load'], egressIps: ['203.0.113.0/24'] },
    venue: { name: 'Local Demo Centro', deletedAt: null, businessId: 'cccccccc-0000-0000-0000-000000000001', business: { name: 'Empresa Demo S.L.', taxId: 'B00000000' } },
    ...over,
  };
}

interface Setup {
  def?: PartnerRouteDef;
  row?: Row | null;
  ip?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  freeze?: 'none' | 'money' | 'all';
  redis?: FakeRedis;
}

function build(setup: Setup = {}) {
  const redis = setup.redis ?? createFakeRedis();
  const tx = {
    partnerConnection: {
      findFirst: vi.fn(async () => (setup.row === undefined ? connection() : setup.row)),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditEvent: { create: vi.fn() },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const cls = new ClsService(new AsyncLocalStorage());
  const audit = { log: vi.fn(async () => undefined), logInTx: vi.fn(async () => undefined) };
  const freeze = { current: vi.fn(async () => setup.freeze ?? 'none') };
  const limiter = new PartnerAuthLimiter(redis as never);
  const guard = new PartnerKeyGuard(
    new Reflector(),
    prisma as never,
    cls as never,
    freeze as never,
    limiter,
    new PartnerRateLimiter(redis as never),
    new PartnerForeignIpService(redis as never, prisma as never, audit as never),
    audit as never,
  );
  const handler = () => undefined;
  Reflect.defineMetadata(PARTNER_ROUTE, setup.def ?? PARTNER_ROUTES.getConnection, handler);
  const req: Record<string, unknown> = {
    url: '/v1/partner/me',
    method: 'GET',
    headers: { authorization: `Bearer ${KEY}`, ...setup.headers },
    raw: { socket: { remoteAddress: setup.ip === undefined ? '203.0.113.9' : (setup.ip ?? undefined) } },
    body: setup.body,
  };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: vi.fn() }) }),
  };
  const run = () => cls.run(async () => {
    cls.set('ctx', { traceId: 't-1' });
    const ok = await guard.canActivate(ctx as never);
    return { ok, ctx: cls.get('ctx') };
  });
  return { run, prisma, tx, redis, audit, req, freeze };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PartnerHttpException);
  return (err as PartnerHttpException).code;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PartnerKeyGuard: paso 1, interruptor y congelación', () => {
  it('apagada o en OxioParty: 404 not_found sin mirar nada más', async () => {
    vi.stubEnv('PARTNER_API_ENABLED', 'false');
    const off = build();
    expect(await codeOf(off.run())).toBe('not_found');
    expect(off.freeze.current).not.toHaveBeenCalled();
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('EDITION', 'party');
    expect(await codeOf(build().run())).toBe('not_found');
  });

  it('congelada del todo: 404; solo el dinero: 403 en las rutas de dinero y las demás siguen', async () => {
    expect(await codeOf(build({ freeze: 'all' }).run())).toBe('not_found');
    expect(await codeOf(build({ freeze: 'money', def: MONEY_ROUTE }).run())).toBe('partner_api_frozen');
    expect((await build({ freeze: 'money' }).run()).ok).toBe(true);
  });

  it('las rutas sin clave (openapi.json) acaban aquí: sin cabecera, sin base', async () => {
    const s = build({ def: PARTNER_ROUTES.getOpenApi, headers: { authorization: '' } });
    expect((await s.run()).ok).toBe(true);
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
  });
});

describe('PartnerKeyGuard: pasos 2 a 5, antes y en la base', () => {
  it('la clave en el cuerpo: 400 api_key_in_body; con Origin: 403 browser_not_allowed', async () => {
    expect(await codeOf(build({ body: { nota: `mira ${KEY}` } }).run())).toBe('api_key_in_body');
    expect(await codeOf(build({ headers: { origin: 'https://evil.example' } }).run())).toBe('browser_not_allowed');
  });

  it('una clave bloqueada: 401 sin ninguna consulta a la base', async () => {
    const redis = createFakeRedis();
    await redis.set(`np:pauth:keyblock:${hashPartnerKey(KEY)}`, '1', 'EX', 900);
    const s = build({ redis });
    expect(await codeOf(s.run())).toBe('invalid_api_key');
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
  });

  it('cortacircuitos (503) e IP bloqueada (429) antes de la base, y la IP bloqueada no suma fallos', async () => {
    const redis = createFakeRedis();
    await redis.set('np:pauth:breaker', '1', 'EX', 60);
    const breaker = build({ redis });
    expect(await codeOf(breaker.run())).toBe('try_later');
    expect(breaker.prisma.asSystem).not.toHaveBeenCalled();

    const blocked = createFakeRedis();
    await blocked.set('np:pauth:ipblock:203.0.113.9', '1', 'EX', 900);
    const s = build({ redis: blocked, row: null });
    for (let i = 0; i < 700; i++) {
      s.req.headers = { authorization: `Bearer oxp_test_${i.toString(16).padStart(48, '0')}` };
      expect(await codeOf(s.run())).toBe('rate_limited');
    }
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
    expect(blocked.keys().filter((k) => k.startsWith('np:pauth:fail:'))).toEqual([]);
  });

  it('con el cortacircuitos levantado, una clave que funcionó hace 2 h entra', async () => {
    const redis = createFakeRedis();
    await redis.set(`np:pauth:ok:${hashPartnerKey(KEY)}`, '1', 'EX', 86_400 - 7200);
    await redis.set('np:pauth:breaker', '1', 'EX', 60);
    expect((await build({ redis }).run()).ok).toBe(true);
  });

  it('un JWT del personal o algo que no es una clave: 401 invalid_api_key, sin base, y cuenta como fallo', async () => {
    const s = build({ headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' } });
    expect(await codeOf(s.run())).toBe('invalid_api_key');
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
    expect(s.redis.keys().some((k) => k.startsWith('np:pauth:fail:'))).toBe(true);
    expect(await codeOf(build({ headers: { authorization: '' } }).run())).toBe('invalid_api_key');
  });

  it('una clave del otro entorno: 401 wrong_environment sin base', async () => {
    const s = build({ headers: { authorization: `Bearer oxp_live_${'0'.repeat(48)}` } });
    expect(await codeOf(s.run())).toBe('wrong_environment');
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
  });

  it('no existe: 401 invalid_api_key y cuenta; cambiada hace menos de 30 días: 401 api_key_rotated y no cuenta', async () => {
    const s = build({ row: null });
    expect(await codeOf(s.run())).toBe('invalid_api_key');
    expect(s.redis.keys().some((k) => k.startsWith('np:pauth:key:'))).toBe(true);

    const redis = createFakeRedis();
    await redis.set(`np:pk-retired:${hashPartnerKey(KEY)}`, '1', 'EX', 30 * 86_400);
    const rotated = build({ row: null, redis });
    expect(await codeOf(rotated.run())).toBe('api_key_rotated');
    expect(redis.keys().filter((k) => k.startsWith('np:pauth:'))).toEqual([]);
  });

  it('IP bloqueada con una clave buena: pasa solo si la conexión está activa y tiene esa IP en su lista', async () => {
    const redis = createFakeRedis();
    await redis.set(`np:pauth:ok:${hashPartnerKey(KEY)}`, '1', 'EX', 86_400);
    await redis.set('np:pauth:ipblock:203.0.113.9', '1', 'EX', 900);
    expect((await build({ redis }).run()).ok).toBe(true);
    expect(await codeOf(build({ redis, row: connection({ ipAllowlist: [] }) }).run())).toBe('rate_limited');
    expect(await codeOf(build({ redis, row: connection({ status: 'PAUSED' }) }).run())).toBe('rate_limited');
  });
});

describe('PartnerKeyGuard: paso 6, la IP antes que el estado', () => {
  it('sin IP conocida (null): 403 ip_not_allowed', async () => {
    expect(await codeOf(build({ ip: null }).run())).toBe('ip_not_allowed');
  });

  it('IP ajena con la clave anulada: 403 ip_not_allowed (no dice que está anulada)', async () => {
    expect(await codeOf(build({ ip: '198.51.100.7', row: connection({ status: 'REVOKED' }) }).run())).toBe('ip_not_allowed');
  });

  it('la IP tiene que estar en la lista de la conexión y en las del socio, leídas ahora', async () => {
    const outOfPartner = connection({ partner: { ...connection().partner, egressIps: ['198.51.100.0/24'] } });
    expect(await codeOf(build({ row: outOfPartner }).run())).toBe('ip_not_allowed');
    expect((await build({ row: connection({ ipAllowlist: [] }), ip: '198.51.100.7' }).run()).ok).toBe(true);
  });
});

describe('PartnerKeyGuard: paso 7, el estado', () => {
  const cases: Array<[string, Partial<Row>, string]> = [
    ['anulada', { status: 'REVOKED' }, 'api_key_revoked'],
    ['el local borrado', { venue: { ...connection().venue, deletedAt: new Date() } }, 'api_key_revoked'],
    ['el local en otra sociedad', { venue: { ...connection().venue, businessId: 'dddddddd-0000-0000-0000-000000000001' } }, 'api_key_revoked'],
    ['caducada', { keyExpiresAt: new Date(NOW.getTime() - 1000) }, 'api_key_expired'],
    ['dormida', { keySuspendedAt: new Date(NOW.getTime() - DAY) }, 'api_key_suspended'],
    ['el socio suspendido', { partner: { ...connection().partner, status: 'SUSPENDED' } }, 'partner_suspended'],
    ['en pausa', { status: 'PAUSED', pausedReason: 'owner' }, 'connection_paused'],
    ['el local sin sociedad', { venue: { ...connection().venue, businessId: null, business: null } }, 'connection_paused'],
    ['la sociedad sin NIF', { venue: { ...connection().venue, business: { name: 'Empresa', taxId: null } } }, 'connection_paused'],
  ];
  it.each(cases)('%s → %s', async (_name, over, code) => {
    expect(await codeOf(build({ row: connection(over) }).run())).toBe(code);
  });

  it('90 días sin uso: la primera vez queda dormida en la base y en el registro', async () => {
    const s = build({ row: connection({ keyCreatedAt: new Date(NOW.getTime() - 91 * DAY), lastUsedAt: new Date(NOW.getTime() - 90.5 * DAY) }) });
    expect(await codeOf(s.run())).toBe('api_key_suspended');
    expect(s.tx.partnerConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ keySuspendedAt: null }), data: { keySuspendedAt: NOW } }),
    );
    expect(s.audit.logInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner.key.suspended' }));
  });

  it('la clave anterior vale hasta que acaba el solape', async () => {
    const row = connection({ keyHash: 'f'.repeat(64), prevKeyHash: hashPartnerKey(KEY), prevKeyExpiresAt: new Date(NOW.getTime() + DAY) });
    const { ctx } = await build({ row }).run();
    expect(ctx).toMatchObject({ partnerConnectionId: row.id, strictTenancy: true });
  });
});

describe('PartnerKeyGuard: pasos 8 a 10', () => {
  it('pone el local, la conexión y strictTenancy en el contexto, y marca la clave como buena', async () => {
    const s = build();
    const { ok, ctx } = await s.run();
    expect(ok).toBe(true);
    expect(ctx).toMatchObject({ tenantId: connection().tenantId, partnerConnectionId: connection().id, strictTenancy: true, traceId: 't-1' });
    expect(await s.redis.get(`np:pauth:ok:${hashPartnerKey(KEY)}`)).toBe('1');
    expect(s.req.partner).toMatchObject({ connection: { id: connection().id }, keyMatch: 'current' });
  });

  it('basta uno de los permisos de la ruta en los de la conexión ∩ el techo del socio, leído ahora', async () => {
    const lowered = connection({ partner: { ...connection().partner, allowedScopes: ['wallet:balance'] } });
    const s = build({ row: lowered, def: MONEY_ROUTE });
    const err = await s.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartnerHttpException);
    expect(err).toMatchObject({ code: 'scope_missing', extra: { required_scope: 'wallet:load' } });
  });

  it('un permiso en pausa: 403 scope_paused en las rutas que lo dicen', async () => {
    const paused = connection({ pausedScopes: ['wallet:load'], pausedReason: 'foreign_ip' });
    expect(await codeOf(build({ row: paused, def: MONEY_ROUTE }).run())).toBe('scope_paused');
    expect((await build({ row: paused }).run()).ok).toBe(true);
  });

  it('más de 600 llamadas en un minuto: 429', async () => {
    const redis = createFakeRedis();
    await redis.set(`np:prl:all:${connection().id}:${Math.floor(NOW.getTime() / 60_000)}`, '600', 'EX', 120);
    expect(await codeOf(build({ redis }).run())).toBe('rate_limited');
  });

  it('el último uso se apunta en las rutas con permiso (no en GET /me) y como mucho una vez por minuto', async () => {
    const me = build();
    await me.run();
    expect(me.tx.partnerConnection.update).not.toHaveBeenCalled();
    const money = build({ def: MONEY_ROUTE });
    await money.run();
    expect(money.tx.partnerConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastUsedAt: NOW, lastUsedIp: '203.0.113.9' } }),
    );
    const recent = build({ def: MONEY_ROUTE, row: connection({ lastUsedAt: new Date(NOW.getTime() - 30_000) }) });
    await recent.run();
    expect(recent.tx.partnerConnection.update).not.toHaveBeenCalled();
  });

  it('Redis caído: 503 try_later (nunca deja pasar a ciegas)', async () => {
    const redis = createFakeRedis();
    vi.spyOn(redis, 'mget').mockRejectedValue(new Error('Connection is closed.'));
    expect(await codeOf(build({ redis }).run())).toBe('try_later');
  });

  it('tras 20 fallos de una clave, la siguiente vez no se consulta la base', async () => {
    const s = build({ row: null });
    for (let i = 0; i < PAUTH_LIMITS.keyFails; i++) await s.run().catch(() => undefined);
    const calls = s.prisma.asSystem.mock.calls.length;
    expect(await codeOf(s.run())).toBe('invalid_api_key');
    expect(s.prisma.asSystem.mock.calls.length).toBe(calls);
  });
});
