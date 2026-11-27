// Integración (Postgres real, FORCE RLS, rol sin superusuario): cobro por el encargado, fase 3
// (migración 20261127235000_documento_companera, 26-nov-2026): el documento de la compañera.
//  - El tipo (DNI, NIE o pasaporte) y el número se guardan cifrados como su cuenta de cobro (pa1:…).
//  - El encargado (y la lista del panel) lo ven tapado; entero, solo el dueño con su 2FA, y queda en
//    el registro (tapado). El registro de cambios tampoco lo guarda entero.
//  - Se borra al darla de baja. El país y los 4 últimos del pasaporte de siempre siguen igual.
//  - La migración se puede repetir sin tocar lo guardado.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { UpdateOperatorSchema, type JwtPayload } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const config = { get: () => undefined, getOrThrow: () => undefined };
const sessions = { revokeAllForUser: vi.fn(async () => 0) };
const operators = new OperatorsService(prisma, {} as never, audit, config as never, {} as never, {} as never, sessions as never);
const admin = new AdminController(prisma, {} as never, audit, operators, {} as never, cls as never, totp, {} as never);

const MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261127235000_documento_companera/migration.sql');

const r = randomUUID().slice(0, 6);
let V: string;
let boss: string;
let manager: string;
let bossSecret: string;
let nerea: string;

function inVenue<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId: V, traceId: `t-doc-${r}` });
    return fn();
  });
}
const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>) =>
  cls.run(async () => {
    cls.set('ctx', { traceId: `t-doc-${r}` });
    return prisma.asSystem(fn);
  });
const jwtOf = (userId: string, role: 'OWNER' | 'MANAGER') => ({ sub: userId, role, tenantId: V }) as unknown as JwtPayload;
const patch = (userId: string, role: 'OWNER' | 'MANAGER', persona: string, dto: Record<string, unknown>) =>
  inVenue(() => admin.updateOperator(V, jwtOf(userId, role), persona, UpdateOperatorSchema.parse(dto)));
const reveal = (userId: string, role: 'OWNER' | 'MANAGER', persona: string, totpCode?: string) =>
  inVenue(() => admin.revealIdDocument(V, jwtOf(userId, role), persona, { totpCode }));
async function codeOfBoss(): Promise<string> {
  await totp.forgetUsedCodes(boss);
  return totpCodeAt(bossSecret);
}
async function failure(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const body = err.getResponse();
  return { status: err.getStatus(), message: typeof body === 'string' ? body : String((body as { message: unknown }).message) };
}
const rawUser = (id: string) =>
  sys(async (tx) => (await tx.$queryRaw<Array<{ j: string }>>`SELECT row_to_json(u)::text AS j FROM users u WHERE u.id = ${id}::uuid`)[0]!.j);
const listed = async (id: string) => (await inVenue(() => admin.listOperators(V, undefined))).find((o) => o.id === id);

beforeAll(async () => {
  await prisma.onModuleInit();
  bossSecret = totp.newSecret();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: `Sala Doc ${r}`, slug: `doc-${r}` } })).id;
    boss = (await tx.user.create({ data: { tenantId: V, email: `jefa-doc-${r}@x.es`, passwordHash: 'x', role: 'OWNER', totpSecret: totp.sealSecret(bossSecret) } })).id;
    manager = (await tx.user.create({ data: { tenantId: V, email: `enc-doc-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
    nerea = (
      await tx.user.create({
        data: { tenantId: V, email: `nerea-doc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Nerea', passportCountry: 'Colombia', passportLast4: '8742' },
      })
    ).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('El documento de la compañera', () => {
  it('el encargado lo pone: se guarda cifrado (ni el tipo ni el número en claro en la base)', async () => {
    const view = await patch(manager, 'MANAGER', nerea, { idDocument: { type: 'DNI', number: '12.345.678-z' } });
    expect(view).toMatchObject({ idDocumentType: 'DNI', idDocumentMasked: '•••• 678Z' });
    const raw = await rawUser(nerea);
    expect(raw).not.toContain('12345678Z');
    expect(raw).not.toMatch(/"idDocumentType":"DNI"/);
    const row = JSON.parse(raw) as { idDocumentType: string; idDocumentNumber: string };
    expect(row.idDocumentType).toMatch(/^pa1:/);
    expect(row.idDocumentNumber).toMatch(/^pa1:/);
  });

  it('el país y los 4 últimos del pasaporte de siempre siguen como estaban', async () => {
    expect(await listed(nerea)).toMatchObject({ passportCountry: 'Colombia', passportLast4: '8742' });
  });

  it('el encargado (y la lista del panel) lo ven tapado', async () => {
    const op = await listed(nerea);
    expect(op).toMatchObject({ idDocumentType: 'DNI', idDocumentMasked: '•••• 678Z' });
    expect(JSON.stringify(op)).not.toContain('12345678Z');
  });

  it('el registro del cambio lo guarda tapado', async () => {
    const events = await sys((tx) => tx.auditEvent.findMany({ where: { action: 'operator.updated', targetId: nerea }, select: { payload: true } }));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('12345678Z');
    expect(JSON.stringify(events)).toContain('•••• 678Z');
  });

  it('entero: el encargado no puede, ni el dueño sin su 2FA', async () => {
    expect((await failure(reveal(manager, 'MANAGER', nerea))).status).toBe(403);
    expect((await failure(reveal(boss, 'OWNER', nerea))).status).toBeGreaterThanOrEqual(400);
    expect((await failure(reveal(boss, 'OWNER', nerea, '000000'))).status).toBeGreaterThanOrEqual(400);
  });

  it('el dueño con su 2FA lo ve entero, y queda en el registro (tapado)', async () => {
    const doc = await reveal(boss, 'OWNER', nerea, await codeOfBoss());
    expect(doc).toEqual({ userId: nerea, type: 'DNI', number: '12345678Z' });
    const seen = await sys((tx) => tx.auditEvent.findMany({ where: { action: 'operator.id_document_revealed', targetId: nerea }, select: { actorId: true, payload: true } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ actorId: boss, payload: { type: 'DNI', number: '•••• 678Z' } });
  });

  it('un DNI con la letra mal no se guarda', () => {
    expect(UpdateOperatorSchema.safeParse({ idDocument: { type: 'DNI', number: '12345678A' } }).success).toBe(false);
  });

  it('el encargado no puede quitarlo (403): el documento cifrado sigue ahí', async () => {
    const res = await failure(patch(manager, 'MANAGER', nerea, { idDocument: null }));
    expect(res.status).toBe(403);
    expect(res.message).toContain('Solo el dueño puede quitar su documento');
    expect(await listed(nerea)).toMatchObject({ idDocumentType: 'DNI', idDocumentMasked: '•••• 678Z' });
    const row = JSON.parse(await rawUser(nerea)) as { idDocumentNumber: string | null };
    expect(row.idDocumentNumber).toMatch(/^pa1:/);
  });

  it('se puede cambiar por otro (NIE) y quitar', async () => {
    expect(await patch(boss, 'OWNER', nerea, { idDocument: { type: 'NIE', number: 'x1234567l' } })).toMatchObject({ idDocumentType: 'NIE', idDocumentMasked: '•••• 567L' });
    expect(await patch(boss, 'OWNER', nerea, { idDocument: null })).toMatchObject({ idDocumentType: null, idDocumentMasked: null });
    expect((await failure(reveal(boss, 'OWNER', nerea, await codeOfBoss()))).status).toBe(404);
  });

  it('de baja: se borra', async () => {
    await patch(manager, 'MANAGER', nerea, { idDocument: { type: 'PASAPORTE', number: 'PAB123456' } });
    await patch(boss, 'OWNER', nerea, { active: false });
    const row = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: nerea }, select: { idDocumentType: true, idDocumentNumber: true, passportLast4: true } }));
    expect(row).toEqual({ idDocumentType: null, idDocumentNumber: null, passportLast4: '8742' });
  });

  it('la migración se puede repetir sin tocar lo guardado', async () => {
    const lola = await sys(async (tx) =>
      (await tx.user.create({ data: { tenantId: V, email: `lola-doc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Lola' } })).id,
    );
    await patch(manager, 'MANAGER', lola, { idDocument: { type: 'DNI', number: '87654321X' } });
    const before = await rawUser(lola);
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await rawUser(lola)).toBe(before);
  });
});
