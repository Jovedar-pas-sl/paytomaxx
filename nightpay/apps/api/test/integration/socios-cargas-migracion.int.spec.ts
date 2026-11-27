// Integración (Postgres de verdad, rol sin superusuario): la migración
// 20261126200000_partner_cargas. Cada CHECK nuevo o reemplazado; el libro
// (partner_wallet_operations) es solo de añadir (UPDATE, DELETE y TRUNCATE
// fallan); FORCE RLS: el local B no ve nada de A; y repetirla no cambia nada.
// Ver README.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261126200000_partner_cargas/migration.sql');
const r = randomUUID().slice(0, 6);

const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>) => cls.run(() => prisma.asSystem(fn));

interface Venue {
  id: string;
  connectionId: string;
  walletId: string;
  cashId: string;
}
let A: Venue;
let B: Venue;
let loadA = '';

async function seed(tag: string): Promise<Venue> {
  return sys(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Mig ${tag} ${r}`, slug: `mig-${tag}-${r}` } });
    const p = await tx.partner.create({
      data: { name: `Mig ${tag} ${r}`, legalName: 'Cajeros S.L.', taxId: 'B12345678', contactEmail: `mig-${tag}-${r}@x.es`, allowedScopes: ['wallet:load'], createdById: randomUUID() },
    });
    const c = await tx.partnerConnection.create({
      data: {
        tenantId: v.id, partnerId: p.id, businessId: randomUUID(), collectionModel: 'VENUE_COLLECTS', channel: 'IN_VENUE', scopes: ['wallet:load'],
        keyMode: 'test', keyHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), keyHint: 'oxp_test_…0000', keyCreatedAt: new Date(),
        keyExpiresAt: new Date(Date.now() + 30 * 86_400_000), createdById: randomUUID(),
      },
    });
    const w = await tx.clientWallet.create({ data: { tenantId: v.id, qrToken: `mig-${tag}-${r}-${randomUUID()}`, balanceCents: 0 } });
    const cash = await tx.walletCashTopUp.create({ data: { tenantId: v.id, walletId: w.id, amountCents: 2000, partnerConnectionId: c.id, idempotencyKey: `partner:mig-${tag}-${r}` } });
    return { id: v.id, connectionId: c.id, walletId: w.id, cashId: cash.id };
  });
}

/** Una LOAD que cumple todo (con tarjeta: sin fila de caja, que es única por carga), con lo que se quiera cambiar. */
function loadRow(v: Venue, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: v.id, connectionId: v.connectionId, kind: 'LOAD', walletId: v.walletId, amountCents: 2000, balanceBeforeCents: 0,
    balanceAfterCents: 2000, description: 'Recarga en cajero 0042', funding: 'card', cashTopupId: null, refKind: 'ficha',
    idempotencyKey: `mig-${randomUUID()}`, requestHash: 'a'.repeat(64), response: { object: 'wallet_load' }, createdAt: new Date(), ...over,
  };
}

async function violates(data: Record<string, unknown>, constraint: string): Promise<void> {
  await expect(sys((tx) => tx.partnerWalletOperation.create({ data: data as never }))).rejects.toThrow(constraint);
}

const constraints = () =>
  prisma.$queryRaw<Array<{ conname: string; def: string; convalidated: boolean }>>`
    SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
     WHERE conrelid IN ('partner_wallet_operations'::regclass, 'wallet_cash_topups'::regclass, 'partner_connections'::regclass)
     ORDER BY conname`;

beforeAll(async () => {
  A = await seed('a');
  B = await seed('b');
  loadA = (await sys((tx) => tx.partnerWalletOperation.create({ data: loadRow(A, { funding: 'cash', cashTopupId: A.cashId }) as never }))).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('partner_wallet_operations: los CHECK', () => {
  it('una LOAD buena entra; una LOAD_VOID buena de esa carga también (una sola por carga)', async () => {
    const v = await sys((tx) =>
      tx.partnerWalletOperation.create({
        data: { tenantId: A.id, connectionId: A.connectionId, kind: 'LOAD_VOID', reversesId: loadA, walletId: A.walletId, amountCents: 2000, balanceBeforeCents: 2000, balanceAfterCents: 0, idempotencyKey: `void:${loadA}`, reason: 'Billetes devueltos', createdAt: new Date() },
      }),
    );
    expect(v.kind).toBe('LOAD_VOID');
    await expect(
      sys((tx) =>
        tx.partnerWalletOperation.create({
          data: { tenantId: A.id, connectionId: A.connectionId, kind: 'LOAD_VOID', reversesId: loadA, walletId: A.walletId, amountCents: 2000, balanceBeforeCents: 2000, balanceAfterCents: 0, idempotencyKey: `void:${loadA}`, createdAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('importe > 0 y saldos ≥ 0 con después = antes ± importe', async () => {
    await violates(loadRow(A, { amountCents: 0, balanceAfterCents: 0, cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_amount_positive');
    await violates(loadRow(A, { balanceAfterCents: 2001, cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_balances');
    await violates(loadRow(A, { balanceBeforeCents: -1, balanceAfterCents: 1999, cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_balances');
  });

  it('LOAD: forma de pago, descripción de 1 a 60, refKind, huella, respuesta y, en efectivo, su fila de caja', async () => {
    for (const over of [
      { funding: null },
      { funding: 'bizum' },
      { description: null },
      { description: 'a'.repeat(61) },
      { refKind: 'qr' },
      { requestHash: 'no-es-una-huella' },
      { response: Prisma.DbNull },
      { funding: 'cash', cashTopupId: null },
      { idempotencyKey: 'corta' },
      { voidedByUserId: randomUUID() },
    ]) {
      await violates(loadRow(A, over), 'partner_wallet_operations_load');
    }
    // 60 puntos de código con un emoji: vale (char_length cuenta puntos de código).
    const ok = await sys((tx) => tx.partnerWalletOperation.create({ data: loadRow(A, { description: `${'a'.repeat(59)}🎉`, cashTopupId: null, funding: 'card' }) as never }));
    expect(ok.description).toHaveLength(61);
  });

  it('LOAD_VOID: con reversesId y sin nada de la carga salvo su fila de caja; el motivo solo en las anulaciones, hasta 140', async () => {
    const base = { tenantId: A.id, connectionId: A.connectionId, kind: 'LOAD_VOID', walletId: A.walletId, amountCents: 1, balanceBeforeCents: 1, balanceAfterCents: 0, createdAt: new Date() };
    const other = (await sys((tx) => tx.partnerWalletOperation.create({ data: loadRow(A, { cashTopupId: null, funding: 'card' }) as never }))).id;
    const v = { ...base, reversesId: other, idempotencyKey: `void:${other}` };
    await violates({ ...base, idempotencyKey: 'void:x' }, 'partner_wallet_operations_void');
    for (const over of [{ funding: 'cash' }, { description: 'x' }, { reference: 'ATM1' }, { device: 'ATM1' }, { refKind: 'ficha' }, { requestHash: 'a'.repeat(64) }, { response: {} }, { idempotencyKey: 'void:otra' }]) {
      await violates({ ...v, ...over }, 'partner_wallet_operations_void');
    }
    await violates({ ...v, reason: 'a'.repeat(141) }, 'partner_wallet_operations_reason');
    await violates(loadRow(A, { reason: 'No en una carga' }), 'partner_wallet_operations_reason');
  });

  it('reference y device con los patrones del contrato', async () => {
    await violates(loadRow(A, { reference: 'con espacio', cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_texts');
    await violates(loadRow(A, { reference: 'a'.repeat(65), cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_texts');
    await violates(loadRow(A, { device: 'ATM.0042', cashTopupId: null, funding: 'card' }), 'partner_wallet_operations_texts');
    const ok = await sys((tx) =>
      tx.partnerWalletOperation.create({ data: loadRow(A, { reference: 'ATM0042:2026/12#05.K7-Q_M', device: 'ATM_0042-b', cashTopupId: null, funding: 'card' }) as never }),
    );
    expect(ok.reference).toBe('ATM0042:2026/12#05.K7-Q_M');
  });

  it('solo de añadir: UPDATE, DELETE y TRUNCATE fallan', async () => {
    await expect(sys((tx) => tx.$executeRaw`UPDATE partner_wallet_operations SET description = 'otra' WHERE id = ${loadA}::uuid`)).rejects.toThrow(/solo de añadir/);
    await expect(sys((tx) => tx.$executeRaw`DELETE FROM partner_wallet_operations WHERE id = ${loadA}::uuid`)).rejects.toThrow(/solo de añadir/);
    await expect(sys((tx) => tx.$executeRawUnsafe('TRUNCATE partner_wallet_operations CASCADE'))).rejects.toThrow(/solo de añadir/);
    expect(await sys((tx) => tx.partnerWalletOperation.count({ where: { id: loadA } }))).toBe(1);
  });

  it('una carga no se borra con su saldo, su conexión ni su local (FK RESTRICT)', async () => {
    await expect(sys((tx) => tx.$executeRaw`DELETE FROM client_wallets WHERE id = ${A.walletId}::uuid`)).rejects.toThrow();
    await expect(sys((tx) => tx.$executeRaw`DELETE FROM partner_connections WHERE id = ${A.connectionId}::uuid`)).rejects.toThrow();
  });
});

describe('wallet_cash_topups y partner_connections: lo reemplazado', () => {
  it('wallet_cash_topups_partner: la fila de un cajero sin comisión ni saldo nuevo', async () => {
    const row = (over: Record<string, unknown>) => ({ tenantId: A.id, walletId: A.walletId, amountCents: 100, partnerConnectionId: A.connectionId, idempotencyKey: `partner:${randomUUID()}`, ...over });
    await expect(sys((tx) => tx.walletCashTopUp.create({ data: row({ serviceFeeBps: 1000, serviceFeeCents: 10 }) }))).rejects.toThrow('wallet_cash_topups_partner');
    await expect(sys((tx) => tx.walletCashTopUp.create({ data: row({ createdWallet: true }) }))).rejects.toThrow('wallet_cash_topups_partner');
    await expect(sys((tx) => tx.walletCashTopUp.create({ data: row({ partnerConnectionId: randomUUID() }) }))).rejects.toThrow();
  });

  it('wallet_cash_topups_taken_by: persona, datáfono o (ahora) la conexión de un cajero; ninguno, no', async () => {
    await expect(
      sys((tx) => tx.walletCashTopUp.create({ data: { tenantId: A.id, walletId: A.walletId, amountCents: 100, idempotencyKey: `nadie:${randomUUID()}` } })),
    ).rejects.toThrow('wallet_cash_topups_taken_by');
  });

  it('partner_connections_paused_reason admite las pausas automáticas de las cargas', async () => {
    for (const reason of ['load_refusals', 'load_burst', 'load_voids', 'foreign_ip']) {
      await sys((tx) => tx.partnerConnection.update({ where: { id: A.connectionId }, data: { pausedReason: reason } }));
    }
    await expect(sys((tx) => tx.partnerConnection.update({ where: { id: A.connectionId }, data: { pausedReason: 'otra' } }))).rejects.toThrow(
      'partner_connections_paused_reason',
    );
    await sys((tx) => tx.partnerConnection.update({ where: { id: A.connectionId }, data: { pausedReason: null } }));
  });
});

describe('FORCE RLS y repetirla', () => {
  it('el local B no ve nada del libro de A (ni con una consulta sin filtro)', async () => {
    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role?.rolsuper || role?.rolbypassrls) {
      // Como entra producción (superusuario): RLS no separa nada; lo separan los WHERE con
      // "tenantId" y "connectionId" del código (socios-cargas*.int.spec.ts lo prueban así).
      const all = await cls.run(() => prisma.withTenant(B.id, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM partner_wallet_operations`));
      expect(Number(all[0]!.n)).toBeGreaterThan(0);
      return;
    }
    const seen = await cls.run(() =>
      prisma.withTenant(B.id, (tx) => tx.$queryRaw<Array<{ tenantId: string }>>`SELECT "tenantId"::text AS "tenantId" FROM partner_wallet_operations`),
    );
    expect(seen.length).toBe(0);
    const mine = await cls.run(() =>
      prisma.withTenant(A.id, (tx) => tx.$queryRaw<Array<{ tenantId: string }>>`SELECT "tenantId"::text AS "tenantId" FROM partner_wallet_operations`),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((x) => x.tenantId))).toEqual(new Set([A.id]));
    await expect(cls.run(() => prisma.withTenant(B.id, (tx) => tx.partnerWalletOperation.create({ data: loadRow(A) as never })))).rejects.toThrow();
  });

  it('repetirla no cambia nada (ni restricciones ni filas)', async () => {
    const before = await constraints();
    const rows = await sys((tx) => tx.partnerWalletOperation.count());
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await constraints()).toEqual(before);
    expect(await sys((tx) => tx.partnerWalletOperation.count())).toBe(rows);
    expect(before.filter((c) => !c.convalidated).map((c) => c.conname)).toEqual([]);
  }, 120_000);
});
