// Salida de recepción y número impreso de las fichas (revisión R5), con dinero
// real en Postgres (FORCE RLS, sin superusuario): efectivo + tarjeta, grupo de
// locales, el tope de 1.000 € en 24 h, devolución a la tarjeta a medias,
// saldos sumados, permisos, el tope de la noche de cada recepcionista, el
// 2FA del encargado, el Face ID del cliente y buscar por el número impreso.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { FichaNumbersService } from '../../src/modules/wallets/ficha-numbers.service';
import { ReceptionPayoutPasskeys } from '../../src/modules/wallets/reception-payout-passkey';
import { ReceptionPayoutService } from '../../src/modules/wallets/reception-payout.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
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
const incidents = new IncidentsService(prisma, audit);
const closeCheck = new CloseCheckService(prisma, incidents, { get: () => undefined } as never);
const walletsAdmin = new WalletsService(prisma, audit, totp as never);

/** Redis en memoria para el QR de la salida con Face ID. */
function memoryRedis() {
  const store = new Map<string, string>();
  return { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); return 'OK'; }, pttl: async (k: string) => (store.has(k) ? 60_000 : -2) };
}
/** La llave del cliente: el «móvil» firma con la del saldo que se le diga. */
let signer: string | null = null;
const passkeys = {
  hasPasskey: async (walletId: string) => (await prisma.walletPasskey.count({ where: { walletId } })) > 0,
  challenge: async (scope: string) => ({ challenge: 'reto', scope }),
  verify: async () => {
    if (!signer) throw new Error('sin llave');
    return signer;
  },
};
const payouts = new ReceptionPayoutService(prisma, audit, totp as never, charges, passkeys as never,
  new ReceptionPayoutPasskeys(memoryRedis() as never), { get: () => 'https://api.prueba.local' } as never);

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

const pay = (who: Person, c: { walletId: string; card: string; uid: string }, amount: number, extra: Partial<{ pin: string; totpCode: string; requestKey: string }> = {}) =>
  scope(who.tenantId, () => payouts.payout(who, c.walletId, { card: c.card, uid: c.uid, pin: PIN, expectedAmountCents: amount, requestKey: extra.requestKey ?? randomUUID(), ...extra }, { ip: '10.9.8.7', userAgent: 'RecepcionPrueba' }));

const auditOf = (action: string, targetId: string) => sys((tx) => tx.auditEvent.findMany({ where: { action, targetId }, orderBy: { id: 'asc' } }));

describe('salida en efectivo (Postgres real)', () => {
  it('efectivo + tarjeta: sale el efectivo; el resto, pedido «A la tarjeta» (Incidencias, cierre de la noche y Saldos), todo con su registro', async () => {
    const c = await client({ cashCents: 5_000, cardCents: 3_000 });
    await expect(pay(people.rx!, c, 5_000)).resolves.toEqual({ kind: 'done', refundedCents: 5_000, remainingCents: 3_000 });
    const w = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: c.walletId } }));
    expect(w).toMatchObject({ balanceCents: 3_000, status: 'ACTIVE' });
    expect(w.closeRequestedAt).toBeInstanceOf(Date);
    const [payout] = await auditOf('wallet.payout', c.walletId);
    expect(payout).toMatchObject({ actorId: people.rx!.userId, ip: '10.9.8.7', userAgent: 'RecepcionPrueba' });
    expect(payout!.payload).toMatchObject({ via: 'reception', refundedCents: 5_000, remainingCents: 3_000, authorisedBy: ['nfc_pin'], requestKey: expect.any(String), payoutId: expect.any(String), cardId: expect.any(String) });
    const [asked] = await auditOf('wallet.close_requested', c.walletId);
    expect(asked!.payload).toMatchObject({ reason: 'card_rest', remainingCents: 3_000 });
    const open = await scope(sala, () => incidents.list(sala));
    expect(open.find((i) => i.kind === 'wallet_close_requested' && i.refId === c.walletId)).toMatchObject({ amountCents: 3_000 });
    const now = new Date();
    const check = await scope(sala, () => closeCheck.check(sala, { id: randomUUID(), openedAt: new Date(now.getTime() - 3_600_000), openingFloatCents: 0 }, { from: new Date(now.getTime() - 3_600_000), to: now }, now));
    expect(JSON.stringify(check.steps.find((s) => s.key === 'saldo'))).toContain(c.walletId);
    const panel = await scope(sala, () => walletsAdmin.listForAdmin({ tenantId: sala, status: 'ACTIVE' }));
    expect(panel.find((x) => x.id === c.walletId)?.closeRequestedAt).toBeTruthy();
  });

  it('un saldo de otro local del grupo: sale en este; el NFC vuelve a este stock. De otro grupo: no', async () => {
    const c = await client({ venue: norte, by: 'rxNorte', cashCents: 4_000 });
    await expect(pay(people.rx!, c, 4_000)).resolves.toMatchObject({ kind: 'done', refundedCents: 4_000, remainingCents: 0 });
    expect(await sys((tx) => tx.walletPayout.findFirstOrThrow({ where: { walletId: c.walletId } }))).toMatchObject({ tenantId: sala, method: 'CASH' });
    expect(await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: c.card } }))).toMatchObject({ status: 'RETURNED', venueId: sala, walletId: null });
    const other = await client({ venue: norte, by: 'rxNorte', cashCents: 4_000 });
    await expect(pay(people.rxFuera!, other, 4_000)).rejects.toMatchObject({ status: 404 });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: other.walletId } }))).toBe(0);
  });

  it('1.000 € en 24 h: con 600 € ya devueltos hoy, solo salen 399,99 € (el resto, pedido)', async () => {
    const c = await client({ cashCents: 70_000 });
    await sys(async (tx) => {
      await tx.walletCashTopUp.create({ data: { tenantId: sala, walletId: c.walletId, amountCents: 80_000, takenByUserId: people.rx!.userId, idempotencyKey: randomUUID(), createdAt: new Date(Date.now() - 30 * 3_600_000) } });
      await tx.walletPayout.create({ data: { tenantId: sala, walletId: c.walletId, amountCents: 60_000, method: 'CASH', status: 'DONE', paidByUserId: people.man!.userId } });
      await tx.clientWallet.update({ where: { id: c.walletId }, data: { balanceCents: 90_000 } });
    });
    const plan = await scope(sala, () => payouts.plan(people.man!, c.walletId));
    expect(plan).toMatchObject({ amountCents: 39_999, needs: 'manager_2fa' });
    await expect(pay(people.man!, c, 39_999)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(pay(people.man!, c, 39_999, { totpCode: '123456' })).resolves.toEqual({ kind: 'done', refundedCents: 39_999, remainingCents: 50_001 });
  });

  it('con una devolución a la tarjeta a medias, recepción no saca efectivo', async () => {
    const c = await client({ cashCents: 3_000 });
    await sys((tx) => tx.walletPayout.create({ data: { tenantId: sala, walletId: c.walletId, amountCents: 1_000, method: 'CARD', status: 'PENDING', paidByUserId: people.owner!.userId } }));
    await expect(pay(people.rx!, c, 3_000)).rejects.toThrow(/tarjeta pendiente/);
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId, method: 'CASH' } }))).toBe(0);
  });

  it('saldos sumados: con el NFC del que se sumó sale el efectivo de los dos', async () => {
    const a = await client({ cashCents: 3_000 });
    const b = await client({ cashCents: 2_000 });
    await scope(sala, () => charges.mergeInto(a.walletId, b.walletId));
    const desk = await scope(sala, () => cards.desk(sala, people.rx!, { card: a.card, uid: a.uid }));
    expect(desk).toMatchObject({ kind: 'saldo', walletId: b.walletId, balanceCents: 5_000, cashOutCents: 5_000 });
    await expect(pay(people.rx!, { walletId: b.walletId, card: a.card, uid: a.uid }, 5_000)).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000, remainingCents: 0 });
  });

  it('permisos: camarero sin puesto no; con «devolver en efectivo» quitado no (y sigue cargando); encargado sin «Dar efectivo» no', async () => {
    const c = await client({ cashCents: 2_000 });
    await expect(pay(people.barra!, c, 2_000)).rejects.toMatchObject({ response: { code: 'CASH_PAYOUT_RECEPTION_ONLY' } });
    await sys((tx) => tx.venue.update({ where: { id: sala }, data: { staffPermissions: { people: { [people.rx2!.userId]: { cashPayout: false } }, roles: { MANAGER: { cash: false } } } } }));
    try {
      await expect(pay(people.rx2!, c, 2_000)).rejects.toMatchObject({ response: { code: 'STAFF_PERMISSION_DENIED', permission: 'cashPayout' } });
      await expect(scope(sala, () => cash.topUp(sala, people.rx2!, { amountCents: 500, idempotencyKey: randomUUID(), wallet: { code: c.code } }))).resolves.toMatchObject({ amountCents: 500 });
      await expect(pay(people.man!, c, 2_500)).rejects.toMatchObject({ response: { permission: 'cash' } });
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: sala }, data: { staffPermissions: Prisma.DbNull } }));
    }
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: c.walletId } }))).toBe(0);
  });

  it('una salida que no se hace (clave repetida) no deja registro: va en su transacción', async () => {
    const a = await client({ cashCents: 1_000 });
    const b = await client({ cashCents: 1_000 });
    const requestKey = randomUUID();
    await pay(people.rx!, a, 1_000, { requestKey });
    await expect(pay(people.rx!, b, 1_000, { requestKey })).rejects.toMatchObject({ status: 409 });
    expect(await auditOf('wallet.payout', b.walletId)).toHaveLength(0);
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: b.walletId } }))).toMatchObject({ balanceCents: 1_000 });
  });
});

describe('tope de la noche de cada recepcionista', () => {
  it('pasado el tope: pendiente del encargado, a Incidencias una vez; en el panel lo confirma con su 2FA aunque sea poco', async () => {
    await sys((tx) => tx.venue.update({ where: { id: solo1 }, data: { nightSettings: { receptionPayoutNightCapCents: 6_000 } } }));
    const rx = people.rxSolo1!;
    const manager = await person('manSolo1', solo1, 'MANAGER', null);
    const a = await client({ venue: solo1, by: 'rxSolo1', cashCents: 5_000 });
    const b = await client({ venue: solo1, by: 'rxSolo1', cashCents: 2_000 });
    const c = await client({ venue: solo1, by: 'rxSolo1', cashCents: 2_000 });
    await expect(pay(rx, a, 5_000)).resolves.toMatchObject({ kind: 'done' });
    await expect(scope(solo1, () => payouts.plan(rx, b.walletId))).resolves.toMatchObject({ needs: 'manager_pending', reasons: ['night_cap'], nightPaidCents: 5_000, nightCapCents: 6_000 });
    await expect(pay(rx, b, 2_000)).resolves.toMatchObject({ kind: 'manager', reasons: ['night_cap'] });
    await expect(pay(rx, c, 2_000)).resolves.toMatchObject({ kind: 'manager' });
    const capRows = await sys((tx) => tx.auditEvent.findMany({ where: { action: 'wallet.reception_payout_cap', actorId: rx.userId } }));
    expect(capRows).toHaveLength(1);
    const open = await scope(solo1, () => incidents.list(solo1));
    expect(open.filter((i) => i.kind === 'reception_payout_cap')).toHaveLength(1);
    expect(open.find((i) => i.kind === 'reception_payout_cap')?.detail).toMatch(/50,00 € devueltos y su tope es 60,00 €/);
    totp.assertForUser.mockClear();
    await expect(scope(solo1, () => charges.payout(manager, b.walletId, { method: 'CASH' }))).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(scope(solo1, () => charges.payout(manager, b.walletId, { method: 'CASH', totpCode: '123456' }))).resolves.toMatchObject({ refundedCents: 2_000 });
    expect(totp.assertForUser).toHaveBeenCalledWith(manager.userId, '123456');
  });

  it('el encargado en recepción pasado su tope pone su 2FA (antes del PIN del cliente)', async () => {
    await sys((tx) => tx.venue.update({ where: { id: solo2 }, data: { nightSettings: { receptionPayoutNightCapCents: 0 } } }));
    const manager = await person('manSolo2', solo2, 'MANAGER', null);
    const c = await client({ venue: solo2, by: 'rxSolo2', cashCents: 1_000 });
    await expect(pay(manager, c, 1_000, { pin: '0000' })).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: c.walletId } }))).toMatchObject({ pinFails: 0 });
    await expect(pay(manager, c, 1_000, { totpCode: '654321' })).resolves.toMatchObject({ kind: 'done' });
    const [row] = await auditOf('wallet.payout', c.walletId);
    expect(row!.payload).toMatchObject({ authorisedBy: ['nfc_pin', 'manager_2fa'] });
  });
});

describe('saldo con Face ID: lo confirma el cliente en su móvil', () => {
  it('NFC + PIN no basta; con su Face ID en su móvil sale sin PIN; con la llave de otro saldo, no', async () => {
    const c = await client({ cashCents: 3_500 });
    await sys((tx) => tx.walletPasskey.create({ data: { walletId: c.walletId, credentialId: `cred-${randomUUID()}`, publicKey: Buffer.from('pk'), counter: 0n, transports: [] } }));
    await expect(pay(people.rx!, c, 3_500)).rejects.toMatchObject({ response: { code: 'PAYOUT_PASSKEY_REQUIRED' } });
    const requestKey = randomUUID();
    const proof = { card: c.card, uid: c.uid, expectedAmountCents: 3_500, requestKey };
    const qr = await scope(sala, () => payouts.requestPasskey(people.rx!, c.walletId, proof));
    expect(qr.url).toMatch(/^https:\/\/api\.prueba\.local\/w\/salida\//);
    const token = qr.url.split('/').pop()!;
    signer = randomUUID();
    await expect(payouts.confirm(token, undefined, { id: 'x' })).rejects.toMatchObject({ response: { code: 'FACE_ID_WRONG' } });
    await expect(scope(sala, () => payouts.passkeyStatus(people.rx!, c.walletId, requestKey))).resolves.toEqual({ status: 'waiting' });
    signer = c.walletId;
    await expect(payouts.confirm(token, undefined, { id: 'x' })).resolves.toEqual({ amountCents: 3_500 });
    await expect(scope(sala, () => payouts.passkeyStatus(people.rx!, c.walletId, requestKey))).resolves.toEqual({ status: 'confirmed' });
    // Otra persona no aprovecha la confirmación.
    await expect(pay(people.rx2!, c, 3_500, { requestKey, pin: undefined })).rejects.toMatchObject({ response: { code: 'PAYOUT_PASSKEY_REQUIRED' } });
    await expect(pay(people.rx!, c, 3_500, { requestKey, pin: undefined })).resolves.toEqual({ kind: 'done', refundedCents: 3_500, remainingCents: 0 });
    const [row] = await auditOf('wallet.payout', c.walletId);
    expect(row!.payload).toMatchObject({ authorisedBy: ['passkey'], requestKey });
    expect(await auditOf('wallet.payout_passkey_confirmed', c.walletId)).toHaveLength(1);
  });
});

describe('número impreso de la ficha', () => {
  async function stocked(venue: string, by: Person) {
    const { card } = await scope(venue, () => cards.newStockToken(venue, { userId: by.userId }));
    const uid = uidOf();
    await scope(venue, () => cards.stock(venue, { userId: by.userId }, { card, uid }));
    return { card, uid };
  }

  it('el mismo número en dos locales sin grupo vale; dentro del mismo local, no (tampoco con otros ceros)', async () => {
    const n = String(Date.now()).slice(-7);
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
    const n = String(Date.now() + 7).slice(-6);
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
    const n = String(Date.now() + 11).slice(-8);
    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: c.card } }));
    await scope(sala, () => cards.setPrintedNumber(people.man!, card.id, n));
    const view = await scope(sala, () => numbers.lookup(people.rx!, `00${n}`));
    expect(view).toMatchObject({ kind: 'saldo', codeHint: `${c.code.slice(0, 3)}-•••`, balanceCents: 2_000, cashOutCents: 2_000, hasPin: true });
    expect(JSON.stringify(view)).not.toContain(c.walletId);
    expect(JSON.stringify(view)).not.toContain(c.code);
    const out = await scope(sala, () => numbers.topUp(people.rx!, { printedNumber: n, amountCents: 1_500, idempotencyKey: randomUUID() }));
    expect(out).toMatchObject({ codeHint: `${c.code.slice(0, 3)}-•••`, amountCents: 1_500, balanceCents: 3_500 });
    expect(JSON.stringify(out)).not.toContain(c.walletId);
    expect(await sys((tx) => tx.auditEvent.count({ where: { action: 'wallet.card_number_lookup', actorId: people.rx!.userId, targetId: card.id } }))).toBe(1);
    const listed = await scope(sala, () => cards.list(sala, { q: n.slice(2) }));
    expect(listed.map((x) => x.id)).toContain(card.id);
  });
});
