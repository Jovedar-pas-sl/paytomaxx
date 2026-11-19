// Integración (Postgres real): OxioParty, las casetas en lista (migración
// 20261120300200_casetas_lista). La organización pone la zona, lo que vende y
// «Abierta ahora» (withTenant, FORCE RLS); quien trabaja en una caseta abre o
// cierra la suya y ninguna otra (sin caseta o archivada, 409 NO_STALL); la
// página de la pulsera lista las activas de su fiesta, nunca las de otra, y
// con la fiesta terminada todas cerradas. Los CHECK de la base y repetir la
// migración. np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { NO_STALL_CODE, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PartyRefundsService } from '../../src/modules/party/party-refunds.service';
import { StallsService } from '../../src/modules/party/stalls.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { assertIfEnrolledForUser: vi.fn(async () => undefined) };
const stalls = new StallsService(prisma, totp as never, audit as never);
const refunds = new PartyRefundsService(prisma, audit as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-casetas' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string, OTHER: string, owner: string, toni: string, ana: string, pep: string;
let cantaro: string, falla: string, archivada: string, deOtra: string, walletV: string;
const jwt = (sub: string, role: string, tenantId: string): JwtPayload => ({ sub, email: `${sub}@x.es`, role, tenantId, venueSlug: `casetas-${r}` }) as JwtPayload;
const ownerJwt = () => jwt(owner, 'OWNER', V);

const openOf = (id: string) => sys(async (tx) => (await tx.stall.findUniqueOrThrow({ where: { id }, select: { openNow: true } })).openNow);

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Fiestas del Barrio', slug: `casetas-${r}`, walletGroup: `gcasetas-${r}` } })).id;
    OTHER = (await tx.venue.create({ data: { name: 'Otra Fiesta', slug: `casetas-otra-${r}`, walletGroup: `gcasetas-otra-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: V, email: `duena-c-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    cantaro = (await tx.stall.create({ data: { tenantId: V, name: 'Peña El Cántaro', managerName: 'Lola', organizerBps: 2500, sortOrder: 1 } })).id;
    falla = (await tx.stall.create({ data: { tenantId: V, name: 'Falla Centro', managerName: 'Pep', organizerBps: 0, sortOrder: 2 } })).id;
    archivada = (await tx.stall.create({ data: { tenantId: V, name: 'Archivada', managerName: 'X', organizerBps: 0, active: false, openNow: true } })).id;
    deOtra = (await tx.stall.create({ data: { tenantId: OTHER, name: 'Caseta de otra fiesta', managerName: 'X', organizerBps: 0, openNow: true } })).id;
    toni = (await tx.user.create({ data: { tenantId: V, email: `toni-c-${r}@x.es`, passwordHash: 'x', role: 'WAITER', stallId: cantaro } })).id;
    ana = (await tx.user.create({ data: { tenantId: V, email: `ana-c-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    pep = (await tx.user.create({ data: { tenantId: OTHER, email: `pep-c-${r}@x.es`, passwordHash: 'x', role: 'MANAGER', stallId: deOtra } })).id;
    walletV = (await tx.clientWallet.create({ data: { tenantId: V, balanceCents: 1000, qrToken: `casetas-${r}-abcdefgh`, shortCode: `C${r}`.toUpperCase().slice(0, 6), walletGroup: `gcasetas-${r}` } })).id;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la organización: zona, qué vende y «Abierta ahora» (withTenant, FORCE RLS)', () => {
  it('se guardan y se listan; de serie, cerrada y sin zona', async () => {
    vi.stubEnv('EDITION', 'party');
    const before = (await inVenue(V, () => stalls.list(V))).find((s) => s.id === falla);
    expect(before).toMatchObject({ zone: null, sells: null, openNow: false });
    await inVenue(V, () => stalls.update(ownerJwt(), cantaro, { zone: 'Junto al escenario', sells: 'Bocadillos, cerveza, refrescos', openNow: true }));
    const after = (await inVenue(V, () => stalls.list(V))).find((s) => s.id === cantaro);
    expect(after).toMatchObject({ zone: 'Junto al escenario', sells: 'Bocadillos, cerveza, refrescos', openNow: true });
    expect(totp.assertIfEnrolledForUser).not.toHaveBeenCalled();
    // La de otra fiesta, ni se ve ni se cambia desde aquí.
    expect((await inVenue(V, () => stalls.list(V))).map((s) => s.id)).not.toContain(deOtra);
    await expect(inVenue(V, () => stalls.update(ownerJwt(), deOtra, { openNow: false }))).rejects.toMatchObject({ status: 404 });
    expect(await openOf(deOtra)).toBe(true);
  });
});

describe('el personal: abre o cierra la suya y ninguna otra', () => {
  it('quien trabaja en una caseta la abre y la cierra; queda en el registro', async () => {
    vi.stubEnv('EDITION', 'party');
    const waiter = jwt(toni, 'WAITER', V);
    expect(await inVenue(V, () => stalls.mine(waiter))).toMatchObject({ id: cantaro, name: 'Peña El Cántaro' });
    await expect(inVenue(V, () => stalls.setMineOpen(waiter, false))).resolves.toEqual({ id: cantaro, name: 'Peña El Cántaro', openNow: false });
    expect(await openOf(cantaro)).toBe(false);
    await inVenue(V, () => stalls.setMineOpen(waiter, true));
    expect(await openOf(cantaro)).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'party.stall.open_changed', tenantId: V, actorId: toni, targetId: cantaro }));
    // Las demás de su fiesta no cambian.
    expect(await openOf(falla)).toBe(false);
  });

  it('sin caseta: null, y abrir da 409 NO_STALL', async () => {
    vi.stubEnv('EDITION', 'party');
    const waiter = jwt(ana, 'WAITER', V);
    expect(await inVenue(V, () => stalls.mine(waiter))).toBeNull();
    await expect(inVenue(V, () => stalls.setMineOpen(waiter, true))).rejects.toMatchObject({ status: 409, response: { code: NO_STALL_CODE } });
  });

  it('con la suya archivada, tampoco (y sigue como estaba)', async () => {
    vi.stubEnv('EDITION', 'party');
    await sys((tx) => tx.user.update({ where: { id: ana }, data: { stallId: archivada } }));
    const waiter = jwt(ana, 'WAITER', V);
    expect(await inVenue(V, () => stalls.mine(waiter))).toBeNull();
    await expect(inVenue(V, () => stalls.setMineOpen(waiter, false))).rejects.toMatchObject({ status: 409 });
    expect(await openOf(archivada)).toBe(true);
    await sys((tx) => tx.user.update({ where: { id: ana }, data: { stallId: null } }));
  });

  it('otra fiesta: su encargado cierra la suya sin tocar las de aquí; con el local cambiado, no encuentra nada', async () => {
    vi.stubEnv('EDITION', 'party');
    await inVenue(OTHER, () => stalls.setMineOpen(jwt(pep, 'MANAGER', OTHER), false));
    expect(await openOf(deOtra)).toBe(false);
    expect(await openOf(cantaro)).toBe(true);
    // Una sesión con el local de aquí y la persona de la otra fiesta: ni la persona ni su caseta se ven.
    await expect(inVenue(V, () => stalls.setMineOpen(jwt(pep, 'MANAGER', V), true))).rejects.toMatchObject({ status: 409 });
    expect(await openOf(deOtra)).toBe(false);
    await sys((tx) => tx.stall.update({ where: { id: deOtra }, data: { openNow: true } }));
  });
});

describe('la página de la pulsera: «Casetas»', () => {
  it('las activas de su fiesta, en su orden, con zona, lo que vende y si está abierta; ni archivadas ni de otra fiesta', async () => {
    vi.stubEnv('EDITION', 'party');
    const page = await refunds.pageData(walletV);
    expect(page.stalls).toEqual([
      { name: 'Peña El Cántaro', zone: 'Junto al escenario', sells: 'Bocadillos, cerveza, refrescos', open: true },
      { name: 'Falla Centro', zone: null, sells: null, open: false },
    ]);
    // Sin dinero ni datos del responsable.
    expect(JSON.stringify(page.stalls)).not.toMatch(/Lola|organizerBps|iban/);
  });

  it('con la fiesta terminada, todas cerradas (ya no se puede cobrar)', async () => {
    vi.stubEnv('EDITION', 'party');
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { eventEndsAt: new Date(Date.now() - 60_000) } }));
    const page = await refunds.pageData(walletV);
    expect(page.stalls.map((s) => s.open)).toEqual([false, false]);
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { eventEndsAt: null } }));
  });
});

describe('la base', () => {
  it('ni zona ni «qué vende» vacías o solo con espacios; con su tope', async () => {
    await expect(sys((tx) => tx.stall.update({ where: { id: falla }, data: { zone: '   ' } }))).rejects.toThrow(/stalls_zone_check/);
    await expect(sys((tx) => tx.stall.update({ where: { id: falla }, data: { sells: '' } }))).rejects.toThrow(/stalls_sells_check/);
    await expect(sys((tx) => tx.stall.update({ where: { id: falla }, data: { zone: 'x'.repeat(61) } }))).rejects.toThrow();
  });

  it('la migración se puede repetir', async () => {
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const file = join(__dirname, '../../../../packages/db/prisma/migrations/20261120300200_casetas_lista/migration.sql');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', file], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await openOf(cantaro)).toBe(true);
  });
});
