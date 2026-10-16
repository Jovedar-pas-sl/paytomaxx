// Integración (Postgres real): pases de Google Wallet — migración, consulta del
// repaso con RLS forzado y el repaso entero con un Google de mentira. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { GoogleWalletService } from '../../src/modules/wallets/google-wallet/google-wallet.service';
import { findDuePasses, type DuePass } from '../../src/modules/wallets/google-wallet/google-wallet-sync';
import { linkHash } from '../../src/modules/wallets/google-wallet/google-wallet-pass';
import { GOOGLE_OAUTH_TOKEN_URL } from '../../src/modules/wallets/google-wallet/google-wallet-jwt';
import type { FetchFn } from '../../src/modules/wallets/google-wallet/google-wallet-client';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => null } as never);

const DB_PKG = join(__dirname, '../../../../packages/db');
const MIGRATION = join(DB_PKG, 'prisma/migrations/20261016200000_google_wallet/migration.sql');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUER = '3388000000099999999';
const ENV: Record<string, string> = {
  GOOGLE_WALLET_ISSUER_ID: ISSUER,
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    client_email: 'wallet@pruebas.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }),
  GOOGLE_WALLET_CLASS_SUFFIX: 'pruebas',
  NEXT_PUBLIC_API_URL: 'https://api.pruebas.test',
};

/** Google de mentira: token y 200 a todo; apunta lo que se le pide. */
function fakeGoogle() {
  const api: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    if (url === GOOGLE_OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    api.push({ method: String(init.method), path: url.split('/walletobjects/v1')[1], body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  };
  return { fetchFn, api };
}

/** Redis de mentira (candado del repaso y límite de toques por saldo). */
function fakeRedis() {
  const store = new Map<string, string | number>();
  return {
    set: async (key: string, value: string) => (store.has(key) ? null : (store.set(key, value), 'OK')),
    incr: async (key: string) => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, n);
      return n;
    },
    pexpire: async () => 1,
    eval: async (_script: string, _keys: number, key: string, value: string) =>
      store.get(key) === value ? Number(store.delete(key)) : 0,
  };
}

function service(fetchFn: FetchFn): GoogleWalletService {
  return new GoogleWalletService(prisma, charges, { get: (k: string) => ENV[k] } as never, fakeRedis() as never, fetchFn);
}

function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
}

const r = randomUUID().slice(0, 8);
const T = (name: string) => `gw-${name}-${r}-abcdefghijkl`;
let venue: string;
const wallets: Record<string, string> = {};
const passes: Record<string, string> = {};

async function wallet(name: string, data: { balanceCents: number; status?: 'ACTIVE' | 'REFUNDED' | 'DEPLETED'; mergedIntoId?: string }) {
  wallets[name] = (
    await prisma.asSystem((tx) =>
      tx.clientWallet.create({
        data: { tenantId: venue, qrToken: T(name), walletGroup: 'principal', status: 'ACTIVE', ...data },
      }),
    )
  ).id;
}

async function pass(name: string, synced: { balanceCents: number; status: 'ACTIVE' | 'REFUNDED' | 'DEPLETED' }, extra: { revokedAt?: Date; minutesAgo?: number } = {}) {
  const row = await prisma.walletPass.create({
    data: {
      walletId: wallets[name],
      objectId: `${ISSUER}.pruebas-${name}-${r}`,
      tokenHash: linkHash(T(name)),
      lastSyncedBalanceCents: synced.balanceCents,
      lastSyncedStatus: synced.status,
      lastSyncedAt: new Date(Date.now() - (extra.minutesAgo ?? 10) * 60_000),
      revokedAt: extra.revokedAt ?? null,
    },
  });
  passes[name] = row.id;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await asPublic(async () => {
    venue = (await prisma.asSystem((tx) => tx.venue.create({ data: { name: 'Luna Pruebas', slug: `gw-${r}`, walletGroup: 'principal' } }))).id;
    await wallet('igual', { balanceCents: 20_000 });
    await wallet('gasto', { balanceCents: 15_000 });
    await wallet('devuelto', { balanceCents: 0, status: 'REFUNDED' });
    await wallet('enlace', { balanceCents: 20_000 });
    await wallet('apagado', { balanceCents: 1 });
    await wallet('otro', { balanceCents: 30_000 });
    await wallet('sumado', { balanceCents: 0, status: 'DEPLETED', mergedIntoId: wallets.otro });
    await pass('igual', { balanceCents: 20_000, status: 'ACTIVE' });
    await pass('gasto', { balanceCents: 20_000, status: 'ACTIVE' }, { minutesAgo: 30 });
    await pass('devuelto', { balanceCents: 0, status: 'ACTIVE' });
    await pass('enlace', { balanceCents: 20_000, status: 'ACTIVE' });
    await pass('apagado', { balanceCents: 20_000, status: 'ACTIVE' }, { revokedAt: new Date() });
    await pass('sumado', { balanceCents: 5_000, status: 'ACTIVE' });
    // El dueño le da un enlace nuevo al saldo "enlace" (móvil perdido).
    await prisma.asSystem((tx) => tx.clientWallet.update({ where: { id: wallets.enlace }, data: { qrToken: T('enlace-nuevo') } }));
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function mine(rows: DuePass[]): Record<string, DuePass> {
  const byId = new Map(Object.entries(passes).map(([name, id]) => [id, name]));
  return Object.fromEntries(rows.filter((p) => byId.has(p.id)).map((p) => [byId.get(p.id), p]));
}

describe('migración 20261016200000_google_wallet', () => {
  it('tabla wallet_passes sin RLS (como wallet_passkeys), borrado en cascada con el saldo y objectId único', async () => {
    const [table] = await prisma.$queryRaw<Array<{ rls: boolean; force: boolean }>>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = to_regclass('wallet_passes')`;
    expect(table).toEqual({ rls: false, force: false });
    const [fk] = await prisma.$queryRaw<Array<{ del: string; upd: string }>>`
      SELECT confdeltype::text AS del, confupdtype::text AS upd FROM pg_constraint WHERE conname = 'wallet_passes_walletId_fkey'`;
    expect(fk).toEqual({ del: 'c', upd: 'c' });
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'wallet_passes' ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual(['wallet_passes_objectId_key', 'wallet_passes_pkey', 'wallet_passes_walletId_idx']);
  });

  it('se puede volver a lanzar sin error (idempotente)', () => {
    const cli = join(DB_PKG, 'node_modules/prisma/build/index.js');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.stderr).not.toMatch(/error/i);
    expect(res.status).toBe(0);
  });
});

describe('consulta del repaso (RLS forzado, rol sin superusuario)', () => {
  it('sin el bypass del sistema no ve los saldos (client_wallets es FORCE RLS): por eso va con asSystem', async () => {
    const rows = await asPublic(() => prisma.$transaction((tx) => findDuePasses(tx, 500)));
    expect(Object.keys(mine(rows))).toEqual([]);
    // wallet_passes no tiene RLS: sus filas se ven sin bypass.
    const own = await prisma.walletPass.count({ where: { id: { in: Object.values(passes) } } });
    expect(own).toBe(6);
  });

  it('con asSystem: saldo, estado o enlace distintos; ni los iguales ni los ya apagados', async () => {
    const due = mine(await asPublic(() => prisma.asSystem((tx) => findDuePasses(tx, 500))));
    expect(Object.keys(due).sort()).toEqual(['devuelto', 'enlace', 'gasto', 'sumado']);
    expect(due.gasto).toMatchObject({ balanceCents: 15_000, lastSyncedBalanceCents: 20_000, sameLink: true, venueName: 'Luna Pruebas' });
    expect(due.devuelto).toMatchObject({ status: 'REFUNDED', lastSyncedStatus: 'ACTIVE', merged: false });
    expect(due.sumado).toMatchObject({ status: 'DEPLETED', merged: true });
    // El hash del enlace en Postgres (sha256 del texto) es el mismo que en el API.
    expect(due.enlace).toMatchObject({ sameLink: false, balanceCents: 20_000, lastSyncedBalanceCents: 20_000 });
    expect(due.gasto.qrToken).toBe(T('gasto'));
  });

  it('los que llevan más tiempo sin repasar, primero; y respeta el límite', async () => {
    const rows = await asPublic(() => prisma.asSystem((tx) => findDuePasses(tx, 500)));
    const order = rows.map((p) => p.id).filter((id) => Object.values(passes).includes(id));
    expect(order[0]).toBe(passes.gasto);
    const one = await asPublic(() => prisma.asSystem((tx) => findDuePasses(tx, 1)));
    expect(one).toHaveLength(1);
  });

  it('uno que acaba de fallar (intento apuntado) pasa al final, pero sigue pendiente', async () => {
    await prisma.walletPass.update({ where: { id: passes.gasto }, data: { lastAttemptAt: new Date() } });
    const rows = await asPublic(() => prisma.asSystem((tx) => findDuePasses(tx, 500)));
    const order = rows.map((p) => p.id).filter((id) => Object.values(passes).includes(id));
    expect(order).toHaveLength(4);
    expect(order[order.length - 1]).toBe(passes.gasto);
  });
});

describe('repaso entero contra la base (Google de mentira)', () => {
  it('pone al día los cambiados, apaga el del enlace viejo y la siguiente vuelta ya no tiene nada', async () => {
    const g = fakeGoogle();
    const svc = service(g.fetchFn);
    const summary = await asPublic(() => svc.syncDue(500));
    expect(summary.failed).toBe(0);
    expect(summary.updated).toBeGreaterThanOrEqual(3);
    expect(summary.revoked).toBeGreaterThanOrEqual(1);

    const rows = await prisma.walletPass.findMany({ where: { id: { in: Object.values(passes) } } });
    const byName = Object.fromEntries(Object.entries(passes).map(([name, id]) => [name, rows.find((p) => p.id === id)]));
    expect(byName.gasto).toMatchObject({ lastSyncedBalanceCents: 15_000, lastSyncedStatus: 'ACTIVE', revokedAt: null });
    expect(byName.devuelto).toMatchObject({ lastSyncedBalanceCents: 0, lastSyncedStatus: 'REFUNDED' });
    expect(byName.sumado).toMatchObject({ lastSyncedStatus: 'DEPLETED' });
    expect(byName.enlace?.revokedAt).toBeInstanceOf(Date);
    expect(byName.igual?.lastSyncedAt.getTime()).toBeLessThan(Date.now() - 5 * 60_000);

    const patched = g.api.filter((c) => c.method === 'PATCH' && c.path.includes(`-${r}`));
    const states = Object.fromEntries(patched.map((c) => [c.path.split(`${ISSUER}.pruebas-`)[1]?.replace(`-${r}`, ''), c.body.state]));
    expect(states).toEqual({ gasto: 'ACTIVE', devuelto: 'INACTIVE', sumado: 'INACTIVE', enlace: 'INACTIVE' });

    const again = mine(await asPublic(() => prisma.asSystem((tx) => findDuePasses(tx, 500))));
    expect(Object.keys(again)).toEqual([]);
  });

  it('«Añadir a Google Wallet» apunta el pase (con el hash del enlace) y otro toque no lo duplica', async () => {
    const g = fakeGoogle();
    const svc = service(g.fetchFn);
    const first = await asPublic(() => svc.saveLink(T('otro')));
    const second = await asPublic(() => svc.saveLink(T('otro')));
    expect(first.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(second.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const rows = await prisma.walletPass.findMany({ where: { walletId: wallets.otro } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: linkHash(T('otro')),
      objectId: `${ISSUER}.pruebas-${linkHash(T('otro')).slice(0, 40)}`,
      lastSyncedBalanceCents: 30_000,
      lastSyncedStatus: 'ACTIVE',
      provider: 'GOOGLE',
    });
    // Un saldo cerrado no da pase.
    await expect(asPublic(() => svc.saveLink(T('devuelto')))).rejects.toThrow(/cerrado/);
  });

  it('borrar el saldo borra sus pases (cascada)', async () => {
    await asPublic(async () => {
      await wallet('borrar', { balanceCents: 100 });
      await pass('borrar', { balanceCents: 100, status: 'ACTIVE' });
      await prisma.asSystem((tx) => tx.clientWallet.delete({ where: { id: wallets.borrar } }));
    });
    expect(await prisma.walletPass.count({ where: { id: passes.borrar } })).toBe(0);
    delete passes.borrar;
  });
});
