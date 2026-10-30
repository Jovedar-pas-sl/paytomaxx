// Integración (Postgres real): «saldo al momento» (H-1, H-2). Los triggers de
// 20261102100000_saldo_al_momento avisan por pg_notify al hacer COMMIT, y la
// conexión que escucha (WalletEventsListener, con el driver pg de verdad)
// reparte: un consumo, una recarga con tarjeta, cancelar un cobro, el cobro
// único pagado con tarjeta… Lo que se deshace o no se ve, no avisa. Con dos
// réplicas, cada una recibe el aviso una vez. np_app sin superusuario y FORCE
// RLS (como el CI). Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { closeLinkedSaldo } from '../../src/modules/payments/cobro-link';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { WalletEventsListener } from '../../src/modules/wallet-events/wallet-events.listener';
import { WalletEventsRelay } from '../../src/modules/wallet-events/wallet-events.relay';
import { WalletStreamHub } from '../../src/modules/wallet-events/wallet-stream.hub';
import type { WalletEvent } from '../../src/modules/wallet-events/wallet-events';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsCreated: { inc: noop }, paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop }, duplicateCharges: { inc: noop } } as never,
  {} as never,
  {} as never,
);
const counters = new Map<string, number>();
const redis = {
  incr: async (k: string) => {
    counters.set(k, (counters.get(k) ?? 0) + 1);
    return counters.get(k)!;
  },
  expire: async () => 1,
};
const topUps = new WalletTopUpService(
  prisma as never,
  { hasPasskey: async () => false, assertOwner: async () => undefined } as never,
  redis as never,
  { get: () => 'secreto-de-cookies-de-integracion-0123456789' } as never,
  { get: () => payments } as never,
);

/** Una réplica del API: su conexión que escucha (pg de verdad, con DATABASE_URL). */
const replica = () => new WalletEventsListener({ get: (k: string) => process.env[k] } as never);
const listener = replica();
const otherReplica = replica();
const events: WalletEvent[] = [];
const otherEvents: WalletEvent[] = [];
/** El saldo que se ve (desde otra conexión) en el momento en que llega su aviso. */
const seenBalance = new Map<string, Promise<number | null>>();

const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
const inVenue = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));
const balanceOf = async (walletId: string) =>
  (await sys((tx) => tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } })))?.balanceCents ?? null;

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`no llegó a tiempo: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const walletEvents = (list: WalletEvent[], walletId: string) => list.filter((e) => e.kind === 'wallet' && e.walletId === walletId);
const chargeEvents = (list: WalletEvent[], chargeId: string) =>
  list.filter((e): e is Extract<WalletEvent, { kind: 'charge' }> => e.kind === 'charge' && e.chargeId === chargeId);
/** Un rato sin avisos nuevos (para comprobar que algo NO avisa). */
const quiet = () => new Promise((r) => setTimeout(r, 400));

const r = randomUUID().slice(0, 6);
let V: string, chica: string, term: string;
let n = 0;

async function wallet(balanceCents: number): Promise<{ id: string; token: string }> {
  n += 1;
  const token = `sam-${r}-${n}`;
  const id = await sys(async (tx) =>
    (
      await tx.clientWallet.create({
        data: { tenantId: V, balanceCents, qrToken: token, shortCode: `M${r.slice(0, 3)}${n}`.toUpperCase().slice(0, 6), walletGroup: `gsam-${r}` },
      })
    ).id,
  );
  return { id, token };
}

const qr = (amountCents: number) =>
  inVenue(V, () => charges.createQrCharge({ userId: chica, role: 'OPERATOR', tenantId: V }, { amountCents, category: 'CHICA_SERVICE' }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Momento', slug: `sam-${r}`, walletGroup: `gsam-${r}` } })).id;
    chica = (
      await tx.user.create({ data: { tenantId: V, email: `sam-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' } })
    ).id;
    term = (await tx.terminal.create({ data: { tenantId: V, externalId: `TSAM-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
  });
  listener.onEvent((e) => {
    events.push(e);
    if (e.kind === 'wallet') seenBalance.set(e.walletId, balanceOf(e.walletId));
  });
  otherReplica.onEvent((e) => otherEvents.push(e));
  listener.onApplicationBootstrap();
  otherReplica.onApplicationBootstrap();
  await until('las dos réplicas escuchando', () => listener.listening && otherReplica.listening);
}, 60_000);

afterAll(async () => {
  await listener.onApplicationShutdown();
  await otherReplica.onApplicationShutdown();
  await prisma.$disconnect();
});

describe('«saldo al momento»: los avisos de Postgres (pg_notify al hacer COMMIT)', () => {
  it('un consumo (el cliente paga el QR de la chica con su llave): avisa del saldo y del cobro pagado, ya con el saldo nuevo', async () => {
    const w = await wallet(10_000);
    const c = await qr(2_500);
    await pub(() => charges.payQrCharge(c.payToken, w.id));
    await until('aviso del saldo', () => walletEvents(events, w.id).length > 0);
    await until('aviso del cobro', () => chargeEvents(events, c.id).length > 0);
    expect(chargeEvents(events, c.id).map((e) => e.status)).toEqual(['ACCEPTED']);
    // Llega después del COMMIT: quien lo lee ya ve el saldo nuevo.
    expect(await seenBalance.get(w.id)).toBe(7_500);
  });

  it('una recarga con tarjeta (aprobada por el banco): avisa del saldo, ya recargado', async () => {
    const w = await wallet(2_000);
    const out = await pub(() => topUps.start(w.token, { amountCents: 5_000, key: `k${randomUUID().replace(/-/g, '')}`.slice(0, 24), lang: 'es' }, 'api.test'));
    const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: out.payToken } }));
    await pub(() => payments.transition(p.id, { type: 'AUTHORIZING' }));
    await sys((tx) => tx.payment.update({ where: { id: p.id }, data: { provider: 'REDSYS', providerTxId: `SAM${r}1` } }));
    const before = walletEvents(events, w.id).length;
    await pub(() => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `SAM${r}1` }));
    await until('aviso de la recarga', () => walletEvents(events, w.id).length > before);
    expect(await seenBalance.get(w.id)).toBe(7_000);
    expect(term).toBeTruthy();
  });

  it('la chica cancela el cobro: avisa CANCELED', async () => {
    const c = await qr(1_000);
    await inVenue(V, () => charges.cancelRequest({ userId: chica, role: 'OPERATOR', tenantId: V }, c.id));
    await until('aviso de cancelado', () => chargeEvents(events, c.id).length > 0);
    expect(chargeEvents(events, c.id).map((e) => e.status)).toEqual(['CANCELED']);
  });

  it('cobro único pagado con tarjeta: el cobro del saldo enlazado se cierra y avisa CANCELED', async () => {
    const c = await qr(1_500);
    const card = await sys((tx) => tx.payment.findFirstOrThrow({ where: { tenantId: V }, select: { id: true } }));
    await sys((tx) => tx.walletChargeRequest.update({ where: { id: c.id }, data: { linkedPaymentId: card.id } }));
    await sys((tx) => closeLinkedSaldo(tx, card.id, 'AUTHORIZED'));
    await until('aviso del cobro único', () => chargeEvents(events, c.id).length > 0);
    expect(chargeEvents(events, c.id).map((e) => e.status)).toEqual(['CANCELED']);
  });

  it('lo que se deshace (ROLLBACK) no avisa', async () => {
    const w = await wallet(3_000);
    await expect(
      sys(async (tx) => {
        await tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: 0 } });
        throw new Error('se deshace');
      }),
    ).rejects.toThrow('se deshace');
    await quiet();
    expect(walletEvents(events, w.id)).toHaveLength(0);
    expect(await balanceOf(w.id)).toBe(3_000);
  });

  it('lo que la página no enseña (un PIN fallado) no avisa; elegir el PIN, sí', async () => {
    const w = await wallet(3_000);
    await sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { pinFails: 1, pinFailedAt: new Date() } }));
    await quiet();
    expect(walletEvents(events, w.id)).toHaveLength(0);
    await sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { pinHash: 'hash-de-prueba' } }));
    await until('aviso del PIN', () => walletEvents(events, w.id).length > 0);
  });

  it('dos réplicas: cada una recibe cada aviso una vez (y cada una avisa a los suyos)', async () => {
    const w = await wallet(4_000);
    await sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: 3_000 } }));
    await until('las dos réplicas', () => walletEvents(events, w.id).length > 0 && walletEvents(otherEvents, w.id).length > 0);
    await quiet();
    expect(walletEvents(events, w.id)).toHaveLength(1);
    expect(walletEvents(otherEvents, w.id)).toHaveLength(1);
  });

  it('/state más barato: el estado de la página sale de UNA transacción (antes, ~8 seguidas) y es el mismo', async () => {
    const w = await wallet(6_000);
    const c = await qr(1_000);
    await pub(() => charges.payQrCharge(c.payToken, w.id));
    const tx = vi.spyOn(prisma, '$transaction');
    const outside = vi.spyOn(prisma.walletPasskey, 'count');
    const state = await pub(() => charges.clientState(w.token));
    expect(tx).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    tx.mockRestore();
    outside.mockRestore();
    expect(state).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE', hasFaceId: false, hasPin: false, venueName: 'Sala Momento' });
    expect(state.movements).toEqual([expect.objectContaining({ kind: 'consumption', amountCents: -1_000, ref: c.ref, venueName: 'Sala Momento' })]);
    await expect(pub(() => charges.clientState('no-existe-este-enlace'))).rejects.toMatchObject({ response: { code: 'WALLET_NOT_FOUND' } });
  });

  it('el reparto: la página abierta recibe «cambió» y la sala del cobro, wallet-charge:update', async () => {
    const hub = new WalletStreamHub();
    const gateway = { emitWalletChargeUpdate: vi.fn() };
    const relay = new WalletEventsRelay(otherReplica, hub, gateway as never);
    relay.onModuleInit();
    const w = await wallet(9_000);
    const chunks: string[] = [];
    hub.open({ walletId: w.id, ip: '203.0.113.1', closeAt: Date.now() + 60_000, sink: { write: (s: string) => chunks.push(s), end: noop } });
    const c = await qr(1_000);
    await pub(() => charges.payQrCharge(c.payToken, w.id));
    await until('la página y la sala', () => chunks.some((s) => s.includes('event: change')) && gateway.emitWalletChargeUpdate.mock.calls.length > 0);
    expect(gateway.emitWalletChargeUpdate).toHaveBeenCalledWith(c.id, 'ACCEPTED');
    relay.onModuleDestroy();
    hub.onModuleDestroy();
  });
});
