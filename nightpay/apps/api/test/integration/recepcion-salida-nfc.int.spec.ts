// Dinero real en Postgres de pruebas: salida con NFC/PIN, sin superusuario.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { hashPin } from '../../src/modules/wallets/wallet-pin';
import { attachCard } from '../../src/modules/wallets/wallet-card-ops';
import { receptionCashPayout } from '../../src/modules/wallets/reception-cash-payout';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { isEnabled: async () => true, assertForUser: vi.fn(async () => undefined) };
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => ({}) } as never, totp as never);
const scope = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> => cls.run(async () => {
  cls.set('ctx', { tenantId, traceId: 'test-salida' });
  return fn();
});
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => scope(undefined, () => prisma.asSystem(fn));
let venue: string;
let rx: string;
let manager: string;
let pinHash: string;
const PIN = '4827';
beforeAll(async () => {
  await prisma.onModuleInit();
  pinHash = await hashPin(PIN, process.env.ENCRYPTION_KEK!);
  await sys(async (tx) => {
    const slug = `salida-${randomUUID().slice(0, 8)}`;
    venue = (await tx.venue.create({ data: { name: 'Recepción pruebas NFC', slug } })).id;
    rx = (await tx.user.create({ data: { tenantId: venue, email: `rx-${slug}@test.local`, passwordHash: 'test', role: 'WAITER', post: 'RECEPCION' } })).id;
    manager = (await tx.user.create({ data: { tenantId: venue, email: `manager-${slug}@test.local`, passwordHash: 'test', role: 'MANAGER' } })).id;
  });
});
afterAll(async () => { await prisma.$disconnect(); });

async function client(amountCents = 5_000) {
  const person = { userId: rx, role: 'WAITER' as const, tenantId: venue };
  const { card } = await scope(venue, () => cards.newStockToken(venue, { userId: rx }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await scope(venue, () => cards.stock(venue, { userId: rx }, { card, uid }));
  const topup = await scope(venue, () => cash.topUp(venue, person, { amountCents, idempotencyKey: randomUUID(), wallet: { create: true } }));
  await scope(venue, () => charges.linkCard(person, { code: topup.code, card, uid }));
  await sys((tx) => tx.clientWallet.update({ where: { id: topup.walletId }, data: { pinHash, pinSetById: null } }));
  return { person, walletId: topup.walletId, card, uid, input: { card, uid, pin: PIN, expectedAmountCents: amountCents, requestKey: randomUUID() } };
}

describe('salida NFC de recepción (Postgres real)', () => {
  it('attachCard y salida concurrentes usan saldo antes de NFC sin interbloqueo', async () => {
    const c = await client();
    let attachedLock!: () => void;
    let payoutLock!: () => void;
    let release!: () => void;
    const attached = new Promise<void>((resolve) => { attachedLock = resolve; });
    const payoutWaiting = new Promise<void>((resolve) => { payoutLock = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const wrapped = (mode: 'attach' | 'payout') => ({
      asSystem: prisma.asSystem.bind(prisma),
      acrossVenues: (fn: (tx: never) => Promise<unknown>) => prisma.acrossVenues(async (tx) => {
        const proxy = new Proxy(tx, { get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key);
          return async (...args: unknown[]) => {
            const sql = Array.isArray(args[0]) ? args[0].join('?') : '';
            const walletLock = sql.includes('FROM client_wallets') && sql.includes('FOR UPDATE');
            if (walletLock && mode === 'payout') payoutLock();
            const result = await Reflect.apply(target.$queryRaw, target, args);
            if (walletLock && mode === 'attach') { attachedLock(); await gate; }
            return result;
          };
        } });
        return fn(proxy as never);
      }),
    });
    const linking = scope(venue, () => attachCard(wrapped('attach') as never, { walletId: c.walletId, venueId: venue, card: c.card, uid: c.uid, by: { userId: rx } }));
    await attached;
    const paying = scope(venue, () => receptionCashPayout({ prisma: wrapped('payout') as never, audit: audit as never, totp: totp as never, checkPin: async () => undefined }, c.person, c.walletId, c.input));
    await payoutWaiting;
    release();
    const [linked, paid] = await Promise.all([linking, paying]);
    expect(linked).toBe(0);
    expect(paid).toMatchObject({ kind: 'done', refundedCents: 5000 });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId } }))).toBe(1);
  });
  it('la misma clave en dos saldos da 409 y revierte saldo y NFC del perdedor', async () => {
    const clients = await Promise.all([client(), client()]);
    const requestKey = randomUUID();
    let inserts = 0;
    let release!: () => void;
    const bothInserting = new Promise<void>((resolve) => { release = resolve; });
    const racingDb = {
      asSystem: prisma.asSystem.bind(prisma),
      acrossVenues: (fn: (tx: never) => Promise<unknown>) => prisma.acrossVenues(async (tx) => fn(new Proxy(tx, {
        get(target, key) {
          if (key !== 'walletPayout') return Reflect.get(target, key);
          return new Proxy(target.walletPayout, { get(payout, operation) {
            if (operation !== 'create') return Reflect.get(payout, operation);
            return async (...args: unknown[]) => {
              if (++inserts === 2) release();
              await bothInserting;
              return Reflect.apply(payout.create, payout, args);
            };
          } });
        },
      }) as never)),
    };
    const results = await Promise.allSettled(clients.map((c) => scope(venue, () => receptionCashPayout({
      prisma: racingDb as never, audit: audit as never, totp: totp as never, checkPin: async () => undefined,
    }, c.person, c.walletId, { ...c.input, requestKey }))));
    expect(inserts).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loserIndex = results.findIndex((r) => r.status === 'rejected');
    expect(results[loserIndex]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const loser = clients[loserIndex];
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: loser.walletId } }))).toMatchObject({ balanceCents: 5000, status: 'ACTIVE' });
    expect(await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: loser.card } }))).toMatchObject({ walletId: loser.walletId, status: 'ISSUED' });
    expect(await sys((tx) => tx.walletPayout.count({ where: { tenantId: venue, requestKey } }))).toBe(1);
  });
  it('dos peticiones simultáneas: un asiento y un recibo idéntico, sin doble devolución', async () => {
    const c = await client();
    const [a, b] = await Promise.all([1, 2].map(() => scope(venue, () => charges.payoutAtReception(c.person, c.walletId, c.input))));
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: 'done', refundedCents: 5_000, remainingCents: 0 });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId } }))).toBe(1);
    const w = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: c.walletId } }));
    expect(w).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(await sys((tx) => tx.walletCard.findUnique({ where: { token: c.card } }))).toMatchObject({ status: 'RETURNED', walletId: null });
  });
  it('cinco PIN malos bloquean el PIN sin sacar dinero', async () => {
    const c = await client();
    for (let i = 0; i < 5; i++) await expect(scope(venue, () => charges.payoutAtReception(c.person, c.walletId, { ...c.input, pin: '9999' }))).rejects.toThrow(/PIN/);
    const w = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: c.walletId } }));
    expect(w.balanceCents).toBe(5_000);
    expect(w.pinLockedAt).toBeInstanceOf(Date);
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId } }))).toBe(0);
  });
  it('150 € esperan al encargado con su 2FA, incluso con umbral local de 200 €', async () => {
    await sys((tx) => tx.venue.update({ where: { id: venue }, data: { refundApprovalThresholdCents: 20_000 } }));
    const c = await client(15_000);
    await expect(scope(venue, () => charges.payoutAtReception(c.person, c.walletId, c.input))).resolves.toMatchObject({ kind: 'manager' });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId } }))).toBe(0);
    await expect(scope(venue, () => charges.payout({ userId: manager, role: 'MANAGER', tenantId: venue }, c.walletId, { method: 'CASH' }))).rejects.toThrow(/2FA|verificación/);
    await scope(venue, () => charges.payout({ userId: manager, role: 'MANAGER', tenantId: venue }, c.walletId, { method: 'CASH', totpCode: '123456' }));
    expect(totp.assertForUser).toHaveBeenCalledWith(manager, '123456');
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId, status: 'DONE' } }))).toBe(1);
  });
});
