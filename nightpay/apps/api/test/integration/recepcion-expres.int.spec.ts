// Integración (Postgres real, np_app y FORCE RLS): recepción exprés.
//  - El número de la ficha (20261024200000): sale solo al crearla, seguido y único.
//  - El NFC acercado: del stock → nuevo; dado a un saldo → ese saldo y lo que tiene
//    (en efectivo no sale nada: el saldo no se devuelve); por el código, lo mismo y el número de su NFC.
//  - Solo quien carga saldos (recepción, encargado, dueño); el camarero de barra, 403.
//  - Una devolución pedida antes de la nueva regla, terminada en efectivo, deja el saldo a 0 y el NFC vuelve al stock: nuevo otra vez.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { ForbiddenException } from '@nestjs/common';
import { SALDO_SE_QUEDA_TEXT, TOP_UP_RECEPTION_ONLY_CODE } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-rx' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let k = 0;
const key = () => `rx-${r}-${(k += 1)}`;
let V: string;
let owner: string;
let rocio: string; // recepción
let pablo: string; // barra

const recepcion = () => ({ userId: rocio, role: 'WAITER' as const });
const barra = () => ({ userId: pablo, role: 'WAITER' as const });

/** Una ficha grabada y apuntada en el stock del local («Preparar fichas»). */
async function stockedCard(): Promise<{ card: string; uid: string; number: number }> {
  const { card } = await inVenue(V, () => cards.newStockToken(V, { userId: rocio }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rocio }, { card, uid }));
  const row = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: card }, select: { number: true } }));
  return { card, uid, number: row.number };
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Bambú (Madrid)', slug: `rx-${r}`, walletGroup: `grx-${r}` } })).id;
    const user = (email: string, role: 'OWNER' | 'WAITER', post?: string) =>
      tx.user.create({ data: { tenantId: V, email: `${email}-${r}@x.es`, passwordHash: 'x', role, ...(post ? { post } : {}) } as never });
    owner = (await user('dueno', 'OWNER')).id;
    rocio = (await user('rocio', 'WAITER', 'RECEPCION')).id;
    pablo = (await user('pablo', 'WAITER', 'BARRA')).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el número de la ficha (20261024200000)', () => {
  it('sale solo al crearla: seguido y sin repetirse', async () => {
    const a = await stockedCard();
    const b = await stockedCard();
    expect(b.number).toBe(a.number + 1);
    await expect(
      sys((tx) => tx.walletCard.create({ data: { token: `dup-${r}-numero-0001`, status: 'STOCK', venueId: V, number: a.number } })),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe('recepción exprés: el NFC acercado (Postgres real)', () => {
  it('del stock → nuevo; tras cobrar en efectivo y darlo → su saldo y lo que tiene (en efectivo no sale nada: la regla)', async () => {
    const nfc = await stockedCard();
    await expect(inVenue(V, () => cards.desk(V, recepcion(), { card: nfc.card, uid: nfc.uid }))).resolves.toEqual({
      kind: 'new',
      fichaNumber: nfc.number,
    });

    // Saldo nuevo en efectivo y, después, el NFC (como hace la pantalla).
    const out = await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 5_000, idempotencyKey: key(), wallet: { create: true } }));
    await inVenue(V, () => charges.linkCard({ ...recepcion(), tenantId: V }, { code: out.code, card: nfc.card, uid: nfc.uid }));

    const view = await inVenue(V, () => cards.desk(V, recepcion(), { card: nfc.card, uid: nfc.uid }));
    expect(view).toMatchObject({
      kind: 'saldo',
      walletId: out.walletId,
      code: out.code,
      balanceCents: 5_000,
      hasPin: false,
      isHomeVenue: true,
      blocked: false,
      closeRequested: false,
      cashOutCents: 0,
      cashOutNote: SALDO_SE_QUEDA_TEXT,
      fichaNumber: nfc.number,
    });
    // Por su código: lo mismo, con el número de su NFC.
    await expect(inVenue(V, () => cards.desk(V, recepcion(), { code: out.code }))).resolves.toMatchObject({
      walletId: out.walletId,
      fichaNumber: nfc.number,
    });
  });

  it('el camarero de barra no carga saldos: 403 «Las recargas se hacen en recepción»', async () => {
    const nfc = await stockedCard();
    const err = await inVenue(V, () => cards.desk(V, barra(), { card: nfc.card, uid: nfc.uid })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: TOP_UP_RECEPTION_ONLY_CODE });
  });

  it('una devolución pedida antes, terminada en efectivo, lo deja a 0 y el NFC vuelve al stock: nuevo otra vez, con su número', async () => {
    const nfc = await stockedCard();
    const out = await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 3_500, idempotencyKey: key(), wallet: { create: true } }));
    await inVenue(V, () => charges.linkCard({ ...recepcion(), tenantId: V }, { code: out.code, card: nfc.card, uid: nfc.uid }));

    // El saldo ya no se devuelve (17-nov-2026): solo se termina una pedida antes (el «Me voy» de antes).
    await sys((tx) => tx.clientWallet.update({ where: { id: out.walletId }, data: { closeRequestedAt: new Date() } }));
    const paid = await inVenue(V, () => charges.payout({ userId: owner, role: 'OWNER', tenantId: V }, out.walletId, { totpCode: '123456', method: 'CASH' }));
    expect(paid).toEqual({ refundedCents: 3_500, method: 'CASH' });
    await expect(inVenue(V, () => cards.desk(V, recepcion(), { card: nfc.card, uid: nfc.uid }))).resolves.toEqual({
      kind: 'new',
      fichaNumber: nfc.number,
    });
    const row = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: nfc.card }, select: { status: true, walletId: true } }));
    expect(row).toEqual({ status: 'RETURNED', walletId: null });
  });
});

describe('recarga en efectivo a una ficha NUEVA: el saldo y la ficha, juntos (prueba real: respuesta perdida)', () => {
  it('el saldo nuevo sale ya con su ficha: aunque la respuesta se pierda, el cliente no se va con la ficha vacía', async () => {
    const nfc = await stockedCard();
    const idempotencyKey = key();
    const out = await inVenue(V, () =>
      cash.topUp(V, recepcion(), { amountCents: 5_000, idempotencyKey, wallet: { create: true, card: nfc.card, uid: nfc.uid } }),
    );
    expect(out).toMatchObject({ createdWallet: true, cardLinked: true, balanceCents: 5_000, replayed: false });
    // La respuesta se perdió y la pantalla lo pregunta otra vez con la misma clave: la misma recarga, con su ficha.
    const again = await inVenue(V, () =>
      cash.topUp(V, recepcion(), { amountCents: 5_000, idempotencyKey, wallet: { create: true, card: nfc.card, uid: nfc.uid } }),
    );
    expect(again).toMatchObject({ topUpId: out.topUpId, walletId: out.walletId, replayed: true, cardLinked: true });
    await expect(inVenue(V, () => cards.desk(V, recepcion(), { card: nfc.card, uid: nfc.uid }))).resolves.toMatchObject({
      kind: 'saldo',
      walletId: out.walletId,
      balanceCents: 5_000,
      fichaNumber: nfc.number,
    });
    const topUps = await sys((tx) => tx.walletCashTopUp.count({ where: { tenantId: V, idempotencyKey } }));
    expect(topUps).toBe(1);
  });

  it('si la ficha no se puede dar (es de otro cliente con saldo), no se carga nada: ni saldo nuevo ni efectivo', async () => {
    const nfc = await stockedCard();
    const first = await inVenue(V, () =>
      cash.topUp(V, recepcion(), { amountCents: 2_000, idempotencyKey: key(), wallet: { create: true, card: nfc.card, uid: nfc.uid } }),
    );
    expect(first.cardLinked).toBe(true);
    const wallets = await sys((tx) => tx.clientWallet.count({ where: { tenantId: V } }));
    const idempotencyKey = key();
    await expect(
      inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 3_000, idempotencyKey, wallet: { create: true, card: nfc.card, uid: nfc.uid } })),
    ).rejects.toThrow(/otro cliente/);
    expect(await sys((tx) => tx.clientWallet.count({ where: { tenantId: V } }))).toBe(wallets);
    expect(await sys((tx) => tx.walletCashTopUp.count({ where: { tenantId: V, idempotencyKey } }))).toBe(0);
  });

  it('la misma clave con otra ficha es otra recarga: no la devuelve como si fuera esa', async () => {
    const a = await stockedCard();
    const b = await stockedCard();
    const idempotencyKey = key();
    await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 1_500, idempotencyKey, wallet: { create: true, card: a.card, uid: a.uid } }));
    await expect(
      inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 1_500, idempotencyKey, wallet: { create: true, card: b.card, uid: b.uid } })),
    ).rejects.toThrow(/otros datos/);
  });
});
