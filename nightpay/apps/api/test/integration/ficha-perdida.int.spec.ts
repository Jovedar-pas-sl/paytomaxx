// Integración (Postgres real, np_app y FORCE RLS): «Ficha perdida» en
// recepción (estudio de fichas, B6).
//  - Con una prueba (aquí, su código o el número de su ficha y su PIN), la ficha
//    nueva queda unida a su saldo y la vieja deja de pagar, en la misma operación.
//  - La nueva se cobra del saldo (Ajustes → Noche, 3 € de fábrica): un consumo
//    de recepción; la pantalla manda lo que dijo y, si cambió, 409.
//  - Sin saldo que la cubra, 409 y no se hace nada (ni se gasta su PIN).
//  - Repetida (se cortó la respuesta), no se cobra dos veces.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { FichaNumbersService } from '../../src/modules/wallets/ficha-numbers.service';
import { ReceptionFichaService } from '../../src/modules/home-topup/reception-ficha.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp as never);
const numbers = new FichaNumbersService(prisma, audit as never, cash);
const fichas = new ReceptionFichaService(prisma, charges, audit as never, { get: () => 'secreto-de-pruebas' } as never, numbers);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-fp' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const digits = r.replace(/\D/g, '').slice(0, 3);
let k = 0;
const key = () => `fp-${r}-${(k += 1)}`;
let V: string;
let rocio: string;
const recepcion = () => ({ userId: rocio, role: 'WAITER' as const, tenantId: V });

async function stockedCard(printed: string): Promise<{ card: string; uid: string }> {
  const { card } = await inVenue(V, () => cards.newStockToken(V, { userId: rocio }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rocio }, { card, uid }));
  await inVenue(V, () => cards.labelStock(recepcion(), { card, uid, printedNumber: printed }));
  return { card, uid };
}

/** Un saldo con su ficha, cargado en efectivo, con PIN 2468. */
async function saldoConFicha(n: string, cents: number) {
  const vieja = await stockedCard(`${n}${digits}1`.slice(0, 12));
  const out = await inVenue(V, () =>
    cash.topUp(V, { userId: rocio, role: 'WAITER' }, { amountCents: cents, idempotencyKey: key(), wallet: { create: true, card: vieja.card, uid: vieja.uid } }),
  );
  await inVenue(undefined, () => charges.setPinFromPayer(out.walletId, '2468'));
  return { vieja, walletId: out.walletId, printed: `${n}${digits}1`.slice(0, 12) };
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Perdidas', slug: `fp-${r}`, walletGroup: `gfp-${r}` } })).id;
    rocio = (await tx.user.create({ data: { tenantId: V, email: `rocio-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'RECEPCION' } as never })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Ficha perdida» en recepción (B6)', () => {
  it('con su código y su PIN: la nueva paga, la vieja no, y se cobran 3 € del saldo', async () => {
    const s = await saldoConFicha('51', 5_000);
    const nueva = await stockedCard(`52${digits}2`.slice(0, 12));
    const out = await inVenue(V, () =>
      fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '2468', feeCents: 300 }),
    );
    expect(out).toMatchObject({ balanceCents: 4_700, feeCents: 300, replacedCards: 1, via: 'pin' });
    const [vieja, nuevaRow, wallet, consumos] = await sys(async (tx) =>
      Promise.all([
        tx.walletCard.findUniqueOrThrow({ where: { token: s.vieja.card }, select: { status: true } }),
        tx.walletCard.findUniqueOrThrow({ where: { token: nueva.card }, select: { status: true, walletId: true } }),
        tx.clientWallet.findUniqueOrThrow({ where: { id: s.walletId }, select: { balanceCents: true } }),
        tx.walletConsumption.findMany({ where: { walletId: s.walletId }, select: { amountCents: true, category: true, notes: true, authMethod: true } }),
      ]),
    );
    expect(vieja.status).toBe('LOST');
    expect(nuevaRow).toMatchObject({ status: 'ISSUED', walletId: s.walletId });
    expect(wallet.balanceCents).toBe(4_700);
    expect(consumos).toEqual([{ amountCents: 300, category: 'VENUE_ENTRY', notes: 'Ficha nueva (perdida la anterior)', authMethod: 'pin' }]);
    // Repetida con la misma ficha nueva (se cortó la respuesta): no se cobra otra vez.
    const again = await inVenue(V, () =>
      fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '2468', feeCents: 300 }),
    );
    expect(again).toMatchObject({ feeCents: 0, replacedCards: 0, balanceCents: 4_700 });
  });

  it('por el número de la ficha perdida y su PIN, lo mismo', async () => {
    const s = await saldoConFicha('53', 2_000);
    const nueva = await stockedCard(`54${digits}2`.slice(0, 12));
    await expect(
      inVenue(V, () => fichas.replaceLost(recepcion(), { printedNumber: s.printed, card: nueva.card, uid: nueva.uid, pin: '2468', feeCents: 300 })),
    ).resolves.toMatchObject({ balanceCents: 1_700, replacedCards: 1 });
  });

  it('sin saldo que la cubra, se dice y no se hace nada (ni se gasta su PIN); otro importe en la pantalla, tampoco', async () => {
    const s = await saldoConFicha('55', 200);
    const nueva = await stockedCard(`56${digits}2`.slice(0, 12));
    const poor = await inVenue(V, () =>
      fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '0000', feeCents: 300 }),
    ).catch((e: unknown) => e);
    expect((poor as HttpException).getResponse()).toMatchObject({ code: 'LOST_FICHA_NO_BALANCE' });
    expect(((poor as HttpException).getResponse() as { message: string }).message).toMatch(/le quedan 2 € y la ficha nueva cuesta 3 €/);
    const after = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: s.walletId }, select: { balanceCents: true, pinFails: true } }));
    expect(after).toEqual({ balanceCents: 200, pinFails: 0 });
    expect(await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: s.vieja.card }, select: { status: true } }))).toEqual({ status: 'ISSUED' });
    const changed = await inVenue(V, () =>
      fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '2468', feeCents: 100 }),
    ).catch((e: unknown) => e);
    expect((changed as HttpException).getResponse()).toMatchObject({ code: 'LOST_FICHA_FEE_CHANGED', feeCents: 300 });
  });

  it('sin prueba, no; el PIN mal cuenta como fallo; a un saldo sin ficha, «Dar ficha a un saldo»', async () => {
    const s = await saldoConFicha('57', 3_000);
    const nueva = await stockedCard(`58${digits}2`.slice(0, 12));
    const none = await inVenue(V, () => fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, feeCents: 300 })).catch(
      (e: unknown) => e,
    );
    expect((none as HttpException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_REQUIRED' });
    await expect(
      inVenue(V, () => fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '1357', feeCents: 300 })),
    ).rejects.toMatchObject({ status: 422 });
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: s.walletId }, select: { pinFails: true } }))).toEqual({ pinFails: 1 });
    // El ajuste del local: 0 = gratis.
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { nightSettings: { lostFichaFeeCents: 0 } } as never }));
    await expect(
      inVenue(V, () => fichas.replaceLost(recepcion(), { walletId: s.walletId, card: nueva.card, uid: nueva.uid, pin: '2468', feeCents: 0 })),
    ).resolves.toMatchObject({ feeCents: 0, balanceCents: 3_000, replacedCards: 1 });
  });
});
