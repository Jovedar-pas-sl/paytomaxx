// Integración (Postgres real, np_app y FORCE RLS): «Aviso en cada cobro».
//  - Apuntarse guarda el navegador en el saldo (tabla nueva con FORCE RLS); quitarlo lo borra.
//  - Cobro con la ficha y el PIN: queda pagado y DESPUÉS sale el aviso («Se han cobrado 12 €»,
//    «En Sala Aviso · te quedan 38 €», «No he sido yo»), con un servicio de avisos de mentira.
//    El navegador que ya no existe (410) se borra. Si el servicio no contesta, el cobro no espera.
//  - «No he sido yo» con el enlace del aviso: la ficha queda BLOCKED, el PIN bloqueado (ya no
//    paga con ellos), el aviso al local en el registro (Incidencias), una sola vez. El enlace de
//    un cobro no sirve para otro saldo. No se devuelve dinero.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { ChargeAlertService, type ChargePushPayload } from '../../src/modules/wallets/charge-alert/charge-alert.service';
import { CHARGE_DISPUTED_ACTION, ChargeDisputeService } from '../../src/modules/wallets/charge-alert/charge-dispute.service';
import { signNotMeToken } from '../../src/modules/wallets/charge-alert/not-me-token';
import type { PushSender } from '../../src/modules/wallets/charge-alert/push-sender';

const ENV = {
  WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es',
  JWT_SECRET: 'secreto-de-pruebas-del-aviso-0123456789abcdef',
};
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 1).toString('base64url');
const ANDROID = `https://fcm.googleapis.com/fcm/send/android-${randomUUID()}`;
const IPHONE_GONE = `https://web.push.apple.com/iphone-${randomUUID()}`;
const plain = (s: string): string => s.replace(new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g'), ' ');

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };

/** El servicio de avisos de mentira: el Android lo recibe, el iPhone ya no existe; `hang` = no contesta. */
let mode: 'ok' | 'hang' = 'ok';
const hanging: Array<() => void> = [];
const sender = vi.fn<PushSender>(async (target) => {
  if (mode === 'hang') return new Promise((resolve) => hanging.push(() => resolve({ statusCode: 201 })));
  return { statusCode: target.endpoint === IPHONE_GONE ? 410 : 201 };
});
const alerts = new ChargeAlertService(prisma, sender, ENV as never);
alerts.sleep = async () => undefined;
const disputes = new ChargeDisputeService(prisma, audit, ENV as never);
const cash = new CashTopUpService(prisma, audit, totp as never);
const cards = new WalletCardsService(prisma, audit);
const charges = new WalletChargesService(prisma as never, audit, { get: () => ({}) } as never, totp as never, undefined, alerts);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-aviso' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let k = 0;
const key = () => `av-${r}-${(k += 1)}`;
let V: string;
let rocio: string;
let chica: string;
let walletId: string;
let ficha: { card: string; uid: string };
const chicaActor = () => ({ userId: chica, role: 'OPERATOR' as const, tenantId: V });

async function charge(amountCents: number): Promise<string> {
  const qr = await inVenue(V, () => charges.createQrCharge(chicaActor(), { amountCents }));
  await inVenue(V, () => charges.payQrChargeWithPin(chicaActor(), qr.id, { card: ficha.card, uid: ficha.uid, pin: '2468' }));
  return qr.id;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Aviso', slug: `av-${r}`, walletGroup: `gav-${r}` } })).id;
    rocio = (await tx.user.create({ data: { tenantId: V, email: `rocio-av-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'RECEPCION' } as never })).id;
    chica = (await tx.user.create({ data: { tenantId: V, email: `chica-av-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Nerea' } as never })).id;
  });
  // Un saldo de 50 € con su ficha y PIN 2468 (como en recepción).
  const { card } = await inVenue(V, () => cards.newStockToken(V, { userId: rocio }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rocio }, { card, uid }));
  ficha = { card, uid };
  const out = await inVenue(V, () =>
    cash.topUp(V, { userId: rocio, role: 'WAITER' }, { amountCents: 5_000, idempotencyKey: key(), wallet: { create: true, card, uid } }),
  );
  walletId = out.walletId;
  await inVenue(undefined, () => charges.setPinFromPayer(walletId, '2468'));
});

afterAll(async () => {
  hanging.splice(0).forEach((release) => release());
  await prisma.$disconnect();
});

describe('«Aviso en cada cobro» (Postgres real)', () => {
  it('apuntarse y quitarlo: una fila por navegador y saldo, con el local del saldo', async () => {
    const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });
    await inVenue(undefined, () => alerts.subscribe(walletId, sub(ANDROID), 'es'));
    await inVenue(undefined, () => alerts.subscribe(walletId, sub(ANDROID), 'es')); // otra vez: la misma fila
    await inVenue(undefined, () => alerts.subscribe(walletId, sub(IPHONE_GONE), 'es'));
    const extra = `https://fcm.googleapis.com/fcm/send/quitar-${r}`;
    await inVenue(undefined, () => alerts.subscribe(walletId, sub(extra), 'es'));
    await inVenue(undefined, () => alerts.unsubscribe(walletId, { endpoint: extra }));
    const rows = await sys((tx) => tx.walletPushSubscription.findMany({ where: { walletId }, select: { endpoint: true, tenantId: true } }));
    expect(rows.map((x) => x.endpoint).sort()).toEqual([ANDROID, IPHONE_GONE].sort());
    expect(rows.every((x) => x.tenantId === V)).toBe(true);
    // Con otro local en la sesión (sin bypass), la base no las enseña.
    const otro = randomUUID();
    const seen = await inVenue(otro, () => prisma.withTenant(otro, (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM wallet_push_subscriptions WHERE "walletId" = ${walletId}::uuid`));
    expect(seen[0]!.n).toBe(0);
  });

  let firstCharge = '';
  let notMeToken = '';

  it('cobro con la ficha y el PIN: pagado y, después, el aviso al móvil (el que ya no existe se borra)', async () => {
    firstCharge = await charge(1_200);
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    const sent = sender.mock.calls.find(([t]) => t.endpoint === ANDROID)!;
    const payload = JSON.parse(sent[1]) as ChargePushPayload;
    expect(plain(payload.title)).toBe('Se han cobrado 12 €');
    expect(plain(payload.body)).toBe('En Sala Aviso · te quedan 38 €');
    expect(payload.notMeLabel).toBe('No he sido yo');
    expect(payload.url).toMatch(/^\/w\/[A-Za-z0-9_-]+$/);
    // Nada del personal en el aviso.
    expect(sent[1]).not.toContain('Nerea');
    notMeToken = payload.notMeUrl.replace('/w/no/', '');
    await vi.waitFor(async () => {
      const rows = await sys((tx) => tx.walletPushSubscription.findMany({ where: { walletId }, select: { endpoint: true, lastSentAt: true } }));
      expect(rows).toEqual([{ endpoint: ANDROID, lastSentAt: expect.any(Date) }]);
    });
    const request = await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: firstCharge }, select: { status: true } }));
    expect(request.status).toBe('ACCEPTED');
  });

  it('si el servicio de avisos no contesta, el cobro no espera', async () => {
    mode = 'hang';
    const started = Date.now();
    const id = await charge(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    await vi.waitFor(() => expect(hanging.length).toBeGreaterThan(0));
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCents: true } }));
    expect(wallet.balanceCents).toBe(3_300);
    expect((await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id } }))).status).toBe('ACCEPTED');
    hanging.splice(0).forEach((release) => release());
    mode = 'ok';
  });

  it('«No he sido yo»: con el enlace de otro saldo no hace nada', async () => {
    const forged = signNotMeToken({ chargeId: firstCharge, walletId: randomUUID() }, Date.now(), ENV.JWT_SECRET);
    expect(await inVenue(undefined, () => disputes.dispute(forged))).toEqual({ state: 'invalid' });
    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: ficha.card }, select: { status: true } }));
    expect(card.status).toBe('ISSUED');
  });

  it('«No he sido yo»: bloquea la ficha y el PIN, avisa al local una vez y no devuelve dinero', async () => {
    const view = await inVenue(undefined, () => disputes.view(notMeToken));
    expect(view).toMatchObject({ state: 'ask', totalCents: 1_200, venueName: 'Sala Aviso' });
    const done = await inVenue(undefined, () => disputes.dispute(notMeToken));
    expect(done).toMatchObject({ state: 'done', blockedCards: 1, pinLocked: true, totalCents: 1_200 });
    const [card, wallet, events] = await sys((tx) =>
      Promise.all([
        tx.walletCard.findUniqueOrThrow({ where: { token: ficha.card }, select: { status: true, blockedAt: true } }),
        tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { pinLockedAt: true, balanceCents: true } }),
        tx.auditEvent.findMany({ where: { action: CHARGE_DISPUTED_ACTION, targetId: firstCharge }, select: { tenantId: true, payload: true } }),
      ]),
    );
    expect(card).toMatchObject({ status: 'BLOCKED', blockedAt: expect.any(Date) });
    expect(wallet.pinLockedAt).toBeInstanceOf(Date);
    expect(wallet.balanceCents).toBe(3_300);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: V, payload: expect.objectContaining({ amountCents: 1_200, cards: 1, pinLocked: true }) });
    // Dos veces (o a la vez): un solo aviso.
    const [a, b] = await Promise.all([inVenue(undefined, () => disputes.dispute(notMeToken)), inVenue(undefined, () => disputes.dispute(notMeToken))]);
    expect([a.state, b.state]).toEqual(['already', 'already']);
    expect(await sys((tx) => tx.auditEvent.count({ where: { action: CHARGE_DISPUTED_ACTION, targetId: firstCharge } }))).toBe(1);
    // Con la ficha y el PIN ya no paga nadie.
    await expect(charge(300)).rejects.toBeDefined();
    expect((await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCents: true } }))).balanceCents).toBe(3_300);
  });
});
