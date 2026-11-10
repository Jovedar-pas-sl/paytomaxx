// Integración (Postgres real, np_app y FORCE RLS): fichas sin equivocarse
// (estudio de fichas del 9-nov, capa A).
//  - A4: al leer la ficha (o buscarla por su número), su última recarga si fue
//    hace menos de 10 min, con el nombre de pila de quien la cargó (nunca el
//    email); una anulada no cuenta.
//  - A9: /w y /r ofrecen los importes de la recepción del local (Ajustes → Noche).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { FichaNumbersService } from '../../src/modules/wallets/ficha-numbers.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { HomeTopUpService } from '../../src/modules/home-topup/home-topup.service';
import { newHomeTopUpCode } from '../../src/modules/home-topup/home-topup-rules';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const numbers = new FichaNumbersService(prisma, audit as never, cash);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-fse' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let k = 0;
const key = () => `fse-${r}-${(k += 1)}`;
let V: string;
let owner: string;
let rocio: string; // recepción, con nombre y apellido
let sinNombre: string; // recepción, sin nombre visible

const recepcion = () => ({ userId: rocio, role: 'WAITER' as const });

/** Una ficha grabada y apuntada en el stock del local, con su número impreso. */
async function stockedCard(printed: string): Promise<{ card: string; uid: string }> {
  const { card } = await inVenue(V, () => cards.newStockToken(V, { userId: rocio }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rocio }, { card, uid }));
  await inVenue(V, () => cards.labelStock({ userId: rocio, role: 'WAITER', tenantId: V }, { card, uid, printedNumber: printed }));
  return { card, uid };
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Fichas', slug: `fse-${r}`, walletGroup: `gfse-${r}` } })).id;
    const user = (email: string, role: 'OWNER' | 'WAITER', post?: string, displayName?: string) =>
      tx.user.create({
        data: { tenantId: V, email: `${email}-${r}@x.es`, passwordHash: 'x', role, ...(post ? { post } : {}), ...(displayName ? { displayName } : {}) } as never,
      });
    owner = (await user('dueno', 'OWNER')).id;
    rocio = (await user('rocio', 'WAITER', 'RECEPCION', 'Rocío Pérez')).id;
    sinNombre = (await user('anon', 'WAITER', 'RECEPCION')).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la última recarga en la fila de la ficha (A4)', () => {
  it('al leer la ficha: «50 € en efectivo (Rocío)», solo el nombre de pila', async () => {
    const f = await stockedCard(`10${r.replace(/\D/g, '').slice(0, 3)}1`.slice(0, 12));
    await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 5_000, idempotencyKey: key(), wallet: { create: true, card: f.card, uid: f.uid } }));
    const view = await inVenue(V, () => cards.desk(V, recepcion(), { card: f.card, uid: f.uid }));
    expect(view.kind).toBe('saldo');
    const last = view.kind === 'saldo' ? view.lastTopUp : null;
    expect(last).toMatchObject({ amountCents: 5_000, method: 'cash', byName: 'Rocío' });
    expect(Date.now() - Date.parse(last!.at)).toBeLessThan(60_000);
    expect(JSON.stringify(view)).not.toContain('@');
  });

  it('por su número impreso, lo mismo (sin el código entero)', async () => {
    const printed = `20${r.replace(/\D/g, '').slice(0, 3)}2`.slice(0, 12);
    const f = await stockedCard(printed);
    await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 2_000, idempotencyKey: key(), wallet: { create: true, card: f.card, uid: f.uid } }));
    const view = await inVenue(V, () => numbers.lookup({ ...recepcion(), tenantId: V }, printed));
    expect(view.kind === 'saldo' ? view.lastTopUp : null).toMatchObject({ amountCents: 2_000, method: 'cash', byName: 'Rocío' });
  });

  it('sin nombre visible, sin nombre (nunca el email)', async () => {
    const f = await stockedCard(`30${r.replace(/\D/g, '').slice(0, 3)}3`.slice(0, 12));
    await inVenue(V, () =>
      cash.topUp(V, { userId: sinNombre, role: 'WAITER' }, { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true, card: f.card, uid: f.uid } }),
    );
    const view = await inVenue(V, () => cards.desk(V, recepcion(), { card: f.card, uid: f.uid }));
    expect(view.kind === 'saldo' ? view.lastTopUp : null).toMatchObject({ amountCents: 1_000, byName: null });
  });

  it('una recarga anulada no cuenta; pasados 10 minutos, tampoco', async () => {
    const f = await stockedCard(`40${r.replace(/\D/g, '').slice(0, 3)}4`.slice(0, 12));
    const out = await inVenue(V, () =>
      cash.topUp(V, recepcion(), { amountCents: 3_000, idempotencyKey: key(), wallet: { create: true, card: f.card, uid: f.uid } }),
    );
    await inVenue(V, () => cash.voidTopUp({ userId: owner, role: 'OWNER', tenantId: V }, out.topUpId, { reason: 'Mal tecleada', totpCode: '123456' }));
    const voided = await inVenue(V, () => cards.desk(V, recepcion(), { card: f.card, uid: f.uid }));
    expect(voided.kind === 'saldo' ? voided.lastTopUp : 'x').toBeNull();

    const g = await stockedCard(`50${r.replace(/\D/g, '').slice(0, 3)}5`.slice(0, 12));
    const old = await inVenue(V, () =>
      cash.topUp(V, recepcion(), { amountCents: 4_000, idempotencyKey: key(), wallet: { create: true, card: g.card, uid: g.uid } }),
    );
    await sys((tx) => tx.walletCashTopUp.update({ where: { id: old.topUpId }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } }));
    const stale = await inVenue(V, () => cards.desk(V, recepcion(), { card: g.card, uid: g.uid }));
    expect(stale.kind === 'saldo' ? stale.lastTopUp : 'x').toBeNull();
  });
});

describe('los mismos importes en recepción, /w y /r (A9)', () => {
  it('los de Ajustes → Noche que valen desde el móvil (euros enteros de 10 a 300 €)', async () => {
    const code = newHomeTopUpCode();
    await sys(async (tx) => {
      await tx.venue.update({
        where: { id: V },
        data: { nightSettings: { receptionQuickAmountsCents: [500, 2_500, 5_000, 7_500] }, homeTopUpEnabled: true, homeTopUpCode: code } as never,
      });
    });
    const f = await stockedCard(`60${r.replace(/\D/g, '').slice(0, 3)}6`.slice(0, 12));
    const out = await inVenue(V, () => cash.topUp(V, recepcion(), { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true, card: f.card, uid: f.uid } }));
    const { qrToken } = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: out.walletId }, select: { qrToken: true } }));
    const self = new WalletTopUpService(prisma, {} as never, {} as never, { get: () => '' } as never, {} as never);
    const w = await inVenue(undefined, () => self.options(qrToken));
    // 5 € no se puede desde el móvil (mínimo 10 €): fuera; los demás, los de la recepción.
    expect(w.presetsCents).toEqual([2_500, 5_000, 7_500]);
    const home = new HomeTopUpService(prisma, {} as never, {} as never, { get: () => '' } as never);
    const page = await inVenue(undefined, () => home.page(code, undefined));
    expect(page?.presetsCents).toEqual([2_500, 5_000, 7_500]);
  });
});
