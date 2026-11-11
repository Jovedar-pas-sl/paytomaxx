// Integración (Postgres real, np_app y FORCE RLS): la ficha en el móvil del
// cliente (estudio de fichas, B7).
//  - «Ver mi saldo con mi PIN»: el mismo PIN, con su propio contador de fallos
//    (5 → esa vista cerrada 15 min; el PIN de pagar no se toca); con el PIN
//    bien, el saldo (nada del enlace privado) durante 10 min.
//  - La página de la ficha enseña «Recargar esta ficha» y «Ver mi saldo con mi
//    PIN» sin el saldo ni el enlace.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletCardViewService } from '../../src/modules/wallets/wallet-card-view.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const cash = new CashTopUpService(prisma, audit as never, totp as never);
const cards = new WalletCardsService(prisma, audit as never);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp as never);
const passkeys = { hasPasskey: vi.fn(async () => false) };
const topUps = { options: vi.fn(async () => ({ allowed: true, block: null, presetsCents: [2_000, 5_000], minCents: 1_000, maxCents: 30_000, serviceFeeBps: null, feesCents: null })) };
const viewFails = new Map<string, number>();
const redis = {
  get: async (k: string) => (viewFails.has(k) ? String(viewFails.get(k)) : null),
  incr: async (k: string) => {
    viewFails.set(k, (viewFails.get(k) ?? 0) + 1);
    return viewFails.get(k)!;
  },
  expire: async () => 1,
  del: async (k: string) => (viewFails.delete(k) ? 1 : 0),
};
const cardView = new WalletCardViewService(
  prisma,
  passkeys as never,
  topUps as never,
  charges,
  { get: () => 'secreto-de-pruebas-ficha-movil' } as never,
  redis as never,
);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-fm' });
    return fn();
  });
const pub = <T>(fn: () => Promise<T>) => inVenue(undefined, fn);
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string;
let rocio: string;
let card: string;
let walletId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Móvil', slug: `fm-${r}`, walletGroup: `gfm-${r}` } })).id;
    rocio = (await tx.user.create({ data: { tenantId: V, email: `rocio-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'RECEPCION' } as never })).id;
  });
  card = (await inVenue(V, () => cards.newStockToken(V, { userId: rocio }))).card;
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rocio }, { card, uid }));
  walletId = (
    await inVenue(V, () =>
      cash.topUp(V, { userId: rocio, role: 'WAITER' }, { amountCents: 3_500, idempotencyKey: `fm-${r}-1`, wallet: { create: true, card, uid } }),
    )
  ).walletId;
  await pub(() => charges.setPinFromPayer(walletId, '2468'));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la ficha en el móvil del cliente (B7)', () => {
  it('la página dice que se puede recargar y ver con el PIN, sin el saldo ni el enlace', async () => {
    const view = await pub(() => cardView.pageView(card));
    expect(view).toMatchObject({ kind: 'setup', hasPin: true, topUp: { allowed: true } });
    const { qrToken } = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { qrToken: true } }));
    expect(JSON.stringify(view)).not.toContain(qrToken);
    expect(JSON.stringify(view)).not.toContain('3500');
  });

  it('«Ver mi saldo con mi PIN»: el PIN mal cuenta en su contador (no en el de pagar); bien, el saldo durante 10 min', async () => {
    await expect(pub(() => cardView.viewWithPin(card, '1357'))).rejects.toMatchObject({ status: 422 });
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { pinFails: true } }))).toEqual({ pinFails: 0 });
    const seen = await pub(() => cardView.viewWithPin(card, '2468'));
    expect(seen.balanceCents).toBe(3_500);
    expect(Date.parse(seen.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    await expect(pub(() => cardView.viewAgain(card, seen.viewToken))).resolves.toMatchObject({ balanceCents: 3_500 });
  });

  it('5 fallos en la vista: se cierra solo la vista (15 min); el pago con PIN sigue funcionando', async () => {
    for (let i = 0; i < 4; i += 1) await expect(pub(() => cardView.viewWithPin(card, '1357'))).rejects.toMatchObject({ status: 422 });
    await expect(pub(() => cardView.viewWithPin(card, '1357'))).rejects.toMatchObject({ status: 429, response: expect.objectContaining({ code: 'CARD_VIEW_LOCKED' }) });
    await expect(pub(() => cardView.viewWithPin(card, '2468'))).rejects.toMatchObject({ status: 429 });
    // El PIN de pagar: ni un fallo ni bloqueado; con él se paga (lo mismo que pide el cobro).
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { pinFails: true, pinLockedAt: true } }))).toEqual({
      pinFails: 0,
      pinLockedAt: null,
    });
    await expect(inVenue(V, () => charges.checkPinForPayout({ userId: rocio, role: 'WAITER', tenantId: V }, walletId, '2468'))).resolves.toBeUndefined();
  });
});
