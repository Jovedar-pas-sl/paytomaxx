// Número impreso de las fichas (revisión R5), con Postgres real (FORCE RLS,
// sin superusuario): único por local o por grupo, buscarlo tapado y recargar
// por número. La salida de recepción ya no devuelve el saldo (decisión del
// dueño, 17-nov-2026): sus pruebas se fueron con ella.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { FichaNumbersService } from '../../src/modules/wallets/ficha-numbers.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletActivationLinkService } from '../../src/modules/wallets/wallet-activation-link.service';
import { hashPin } from '../../src/modules/wallets/wallet-pin';

type Tx = Parameters<Parameters<PrismaService['asSystem']>[0]>[0];
type Person = { userId: string; role: 'WAITER' | 'MANAGER' | 'OWNER'; tenantId: string };

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const totp = { isEnabled: vi.fn(async () => true), assertForUser: vi.fn(async () => undefined) };
const cash = new CashTopUpService(prisma, audit, totp as never);
const cards = new WalletCardsService(prisma, audit);
const charges = new WalletChargesService(prisma, audit, { get: () => ({}) } as never, totp as never);
const numbers = new FichaNumbersService(prisma, audit, cash);
/** La llave del cliente (aquí nadie firma: no hace falta para el QR de activación). */
const passkeys = {
  hasPasskey: async (walletId: string) => (await prisma.walletPasskey.count({ where: { walletId } })) > 0,
  challenge: async (scope: string) => ({ challenge: 'reto', scope }),
  verify: async () => {
    throw new Error('sin llave');
  },
};
const activation = new WalletActivationLinkService(prisma, audit, passkeys as never, { get: () => 'https://api.prueba.local' } as never);

const scope = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> => cls.run(async () => {
  cls.set('ctx', { tenantId, traceId: `r5-${randomUUID().slice(0, 8)}` });
  return fn();
});
const sys = <T>(fn: (tx: Tx) => Promise<T>) => scope(undefined, () => prisma.asSystem(fn));

const PIN = '4827';
let pinHash: string;
const r = randomUUID().slice(0, 8);
let sala: string;
let norte: string;
let fuera: string;
let solo1: string;
let solo2: string;
const people: Record<string, Person> = {};

async function person(key: string, tenantId: string, role: Person['role'], post: string | null): Promise<Person> {
  const id = (await sys((tx) => tx.user.create({ data: { tenantId, email: `${key}-${r}@test.local`, passwordHash: 'x', role, post } }))).id;
  people[key] = { userId: id, role, tenantId };
  return people[key]!;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  pinHash = await hashPin(PIN, process.env.ENCRYPTION_KEK!);
  await sys(async (tx) => {
    sala = (await tx.venue.create({ data: { name: 'Sala R5', slug: `r5-sala-${r}`, walletGroup: `g-r5-${r}` } })).id;
    norte = (await tx.venue.create({ data: { name: 'Norte R5', slug: `r5-norte-${r}`, walletGroup: `g-r5-${r}` } })).id;
    fuera = (await tx.venue.create({ data: { name: 'Fuera R5', slug: `r5-fuera-${r}`, walletGroup: `g-otro-${r}` } })).id;
    solo1 = (await tx.venue.create({ data: { name: 'Solo1 R5', slug: `r5-solo1-${r}` } })).id;
    solo2 = (await tx.venue.create({ data: { name: 'Solo2 R5', slug: `r5-solo2-${r}` } })).id;
  });
  await person('rx', sala, 'WAITER', 'RECEPCION');
  await person('rx2', sala, 'WAITER', 'RECEPCION');
  await person('rxNorte', norte, 'WAITER', 'RECEPCION');
  await person('rxFuera', fuera, 'WAITER', 'RECEPCION');
  await person('barra', sala, 'WAITER', null);
  await person('man', sala, 'MANAGER', null);
  await person('owner', sala, 'OWNER', null);
  await person('rxSolo1', solo1, 'WAITER', 'RECEPCION');
  await person('rxSolo2', solo2, 'WAITER', 'RECEPCION');
});
afterAll(async () => { await prisma.$disconnect(); });

const uidOf = () => randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();

/** Un cliente: NFC preparado en `venue`, saldo con efectivo, su NFC y su PIN. */
async function client(o: { venue?: string; by?: string; cashCents?: number; cardCents?: number } = {}) {
  const venue = o.venue ?? sala;
  const by = people[o.by ?? 'rx']!;
  const { card } = await scope(venue, () => cards.newStockToken(venue, { userId: by.userId }));
  const uid = uidOf();
  await scope(venue, () => cards.stock(venue, { userId: by.userId }, { card, uid }));
  const topup = await scope(venue, () => cash.topUp(venue, by, { amountCents: o.cashCents ?? 5_000, idempotencyKey: randomUUID(), wallet: { create: true } }));
  await scope(venue, () => charges.linkCard(by, { code: topup.code, card, uid }));
  // Lo de la tarjeta: saldo sin efectivo detrás (lo que cargó con tarjeta).
  await sys((tx) => tx.clientWallet.update({ where: { id: topup.walletId }, data: { pinHash, pinSetById: null, balanceCents: { increment: o.cardCents ?? 0 } } }));
  return { walletId: topup.walletId, code: topup.code, card, uid };
}

/**
 * Un número de ficha de `digits` cifras sacado del reloj (no se repite entre
 * pasadas) que nunca empieza por 0: si empezara, al quitarle los ceros ya no
 * sería el mismo y las cuentas del test fallarían según la hora.
 */
function fichaNumber(digits: number, offset = 0): string {
  return `9${String(Date.now() + offset).slice(-(digits - 1))}`;
}

describe('número impreso de la ficha', () => {
  async function stocked(venue: string, by: Person) {
    const { card } = await scope(venue, () => cards.newStockToken(venue, { userId: by.userId }));
    const uid = uidOf();
    await scope(venue, () => cards.stock(venue, { userId: by.userId }, { card, uid }));
    return { card, uid };
  }

  it('el mismo número en dos locales sin grupo vale; dentro del mismo local, no (tampoco con otros ceros)', async () => {
    const n = fichaNumber(7);
    const a = await stocked(solo1, people.rxSolo1!);
    const b = await stocked(solo2, people.rxSolo2!);
    const a2 = await stocked(solo1, people.rxSolo1!);
    await expect(scope(solo1, () => cards.labelStock(people.rxSolo1!, { ...a, printedNumber: `00${n}` }))).resolves.toEqual({ printedNumber: `00${n}` });
    await expect(scope(solo2, () => cards.labelStock(people.rxSolo2!, { ...b, printedNumber: n }))).resolves.toEqual({ printedNumber: n });
    await expect(scope(solo1, () => cards.labelStock(people.rxSolo1!, { ...a2, printedNumber: n }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/este local/) });
    const row = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: a.card } }));
    expect(row).toMatchObject({ printedNumber: `00${n}`, printedNumberNorm: n, printedScope: `v:${solo1}` });
    // La base también lo para (dos a la vez): el índice por sitio y número.
    await expect(sys((tx) => tx.walletCard.update({ where: { token: a2.card }, data: { printedNumber: n, printedNumberNorm: n, printedScope: `v:${solo1}` } }))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('en un grupo no se repite entre sus locales; desde el otro local se encuentra, con o sin ceros, tapado', async () => {
    const n = fichaNumber(6, 7);
    const f = await stocked(sala, people.rx!);
    const g = await stocked(norte, people.rxNorte!);
    await scope(sala, () => cards.labelStock(people.rx!, { ...f, printedNumber: `0${n}` }));
    await expect(scope(norte, () => cards.labelStock(people.rxNorte!, { ...g, printedNumber: n }))).rejects.toMatchObject({ status: 409 });
    // Entrada por número con una ficha del stock: no se carga, se acerca.
    await expect(scope(norte, () => numbers.lookup(people.rxNorte!, `000${n}`))).resolves.toEqual({ kind: 'new', printedNumber: `000${n}` });
    await expect(scope(norte, () => numbers.topUp(people.rxNorte!, { printedNumber: n, amountCents: 2_000, idempotencyKey: randomUUID() }))).rejects.toMatchObject({
      response: { message: 'Para cargar una ficha nueva, acércala', code: 'NEW_FICHA_NEEDS_TAP' },
    });
    expect(await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: f.card } }))).toMatchObject({ status: 'STOCK', walletId: null });
    // De otro grupo, ni se ve.
    await expect(scope(fuera, () => numbers.lookup(people.rxFuera!, n))).rejects.toMatchObject({ status: 404 });
  });

  it('un saldo que ya existe: por número solo se ve tapado y se recarga en efectivo; cada búsqueda queda registrada', async () => {
    const c = await client({ cashCents: 2_000 });
    const n = fichaNumber(8, 11);
    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: c.card } }));
    await scope(sala, () => cards.setPrintedNumber(people.man!, card.id, n));
    const view = await scope(sala, () => numbers.lookup(people.rx!, `00${n}`));
    expect(view).toMatchObject({ kind: 'saldo', codeHint: `${c.code.slice(0, 3)}-•••`, balanceCents: 2_000, cashOutCents: 0, hasPin: true });
    expect(JSON.stringify(view)).not.toContain(c.walletId);
    expect(JSON.stringify(view)).not.toContain(c.code);
    const out = await scope(sala, () => numbers.topUp(people.rx!, { printedNumber: n, amountCents: 1_500, idempotencyKey: randomUUID() }));
    expect(out).toMatchObject({ codeHint: `${c.code.slice(0, 3)}-•••`, amountCents: 1_500, balanceCents: 3_500 });
    expect(JSON.stringify(out)).not.toContain(c.walletId);
    expect(await sys((tx) => tx.auditEvent.count({ where: { action: 'wallet.card_number_lookup', actorId: people.rx!.userId, targetId: card.id } }))).toBe(1);
    const listed = await scope(sala, () => cards.list(sala, { q: n.slice(2) }));
    expect(listed.map((x) => x.id)).toContain(card.id);
  });

  it('una recarga por número no abre el QR de activación (no prueba que la ficha esté delante); una con el código, sí', async () => {
    const c = await client({ cashCents: 1_000 });
    // Su primera recarga, de hace rato (fuera de los 15 min).
    await sys((tx) => tx.walletCashTopUp.updateMany({ where: { walletId: c.walletId }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } }));
    const n = fichaNumber(8, 13);
    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: c.card } }));
    await scope(sala, () => cards.setPrintedNumber(people.man!, card.id, n));
    await scope(sala, () => numbers.topUp(people.rx!, { printedNumber: n, amountCents: 500, idempotencyKey: randomUUID() }));
    const row = await sys((tx) => tx.walletCashTopUp.findFirstOrThrow({ where: { walletId: c.walletId }, orderBy: { createdAt: 'desc' } }));
    expect(row.intentFingerprint).toMatch(/^printed:/);
    await expect(scope(sala, () => activation.link(people.rx!, c.walletId))).rejects.toMatchObject({
      status: 404, response: { code: 'ACTIVATION_LINK_UNAVAILABLE', reason: 'NO_RECENT_TOP_UP' },
    });
    await scope(sala, () => cash.topUp(sala, people.rx!, { amountCents: 500, idempotencyKey: randomUUID(), wallet: { code: c.code } }));
    await expect(scope(sala, () => activation.link(people.rx!, c.walletId))).resolves.toMatchObject({ url: expect.stringContaining('/w/') });
  });
});
