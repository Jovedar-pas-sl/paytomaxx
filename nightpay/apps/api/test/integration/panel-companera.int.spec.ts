// Integración (Postgres real, np_app con FORCE RLS): el panel de la compañera en la app del personal (19-nov-2026).
//  - «Historial» de sus ganancias y «Pagos recibidos», por páginas y entre dos fechas: cada fila una vez y en
//    orden aunque dos tengan el mismo milisegundo, solo las suyas y de su local, y el pago con su justificante.
//  - «Cobros» con fechas: solo los suyos de entre esas fechas, y sin el total de la noche.
//  - «Te han pagado»: apuntar el móvil (tabla `staff_push_subscriptions` con FORCE RLS: otro local no la ve),
//    el aviso «Te han pagado 37,50 €» al apuntarle un pago (solo a sus móviles, sin esperar al servicio de
//    avisos), un móvil avisa a una sola persona, el que ya no existe (410) se borra; sin claves, apagado.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { OwnHistoryQuerySchema, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { OwnCobrosController } from '../../src/modules/money-map/own-cobros.controller';
import { OperatorsController } from '../../src/modules/operators/operators.controller';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { StaffPushService } from '../../src/modules/operators/staff-push.service';
import type { PushSender } from '../../src/modules/wallets/charge-alert/push-sender';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const config = { get: () => undefined, getOrThrow: () => undefined };
// El servicio de avisos de mentira: apunta lo que se manda y contesta lo que diga `pushStatus`.
const VAPID = {
  WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es',
};
const pushed: Array<{ endpoint: string; payload: { title: string; url: string } }> = [];
let pushStatus = 201;
const sender: PushSender = async (target, payload) => {
  pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as { title: string; url: string } });
  return { statusCode: pushStatus };
};
const push = new StaffPushService(prisma, sender, VAPID);
push.sleep = async () => undefined;
const operators = new OperatorsService(prisma, {} as never, audit as never, config as never, {} as never, {} as never, {} as never, push);
const controller = new OperatorsController(operators, push);
// «Esta noche» no se pide con fechas: si se pidiera, la prueba lo diría.
const own = new OwnCobrosController(new CobrosService(prisma), { currentWindow: async () => { throw new Error('sin noche con fechas'); } } as never);

/** Una petición de la app (como tras AuthGuard): el local de la sesión en el contexto. */
const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-panel' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string, W: string, owner: string, lucia: string, carmen: string, otra: string, term: string;
let seq = 0;
const jwt = (sub: string, tenantId: string) => ({ sub, tenantId, role: 'OPERATOR' }) as JwtPayload;
const q = (raw: Record<string, unknown>) => OwnHistoryQuerySchema.parse(raw);

/** Una comisión de `cents` del saldo (con su consumo) a esa hora exacta (texto de Postgres: con microsegundos). */
async function earningAt(tenantId: string, operatorId: string, at: string, cents: number): Promise<string> {
  return sys(async (tx) => {
    const wallet = await tx.clientWallet.create({ data: { tenantId, balanceCents: 0, qrToken: `pc-${r}-${(seq += 1)}-abcdefgh` } });
    const c = await tx.walletConsumption.create({ data: { tenantId, walletId: wallet.id, amountCents: cents * 2, providedByUserId: operatorId, category: 'CHICA_SERVICE' } });
    const e = await tx.operatorEarning.create({
      data: { tenantId, operatorId, consumptionId: c.id, paymentAmountCents: cents * 2, commissionBps: 5000, commissionCents: cents },
    });
    await tx.$executeRaw`UPDATE operator_earnings SET "createdAt" = ${at}::timestamptz WHERE id = ${e.id}::uuid`;
    return e.id;
  });
}

async function payoutAt(tenantId: string, operatorId: string, at: string, cents: number, receipt?: { tx: string; url: string }): Promise<string> {
  return sys(async (tx) => {
    const p = await tx.operatorPayout.create({
      data: {
        tenantId, operatorId, totalCents: cents, paidByUserId: owner, externalRail: 'SEPA_IBAN',
        ...(receipt ? { externalTxId: receipt.tx, receiptUrl: receipt.url } : {}),
      },
    });
    await tx.$executeRaw`UPDATE operator_payouts SET "createdAt" = ${at}::timestamptz WHERE id = ${p.id}::uuid`;
    return p.id;
  });
}

async function cobroAt(tenantId: string, by: string, at: string, cents: number): Promise<string> {
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId, terminalId: term, idempotencyKey: `pc-${r}-${(seq += 1)}`, qrToken: `pc-${r}-${seq}`, qrExpiresAt: new Date(Date.now() + 3_600_000),
        amountCents: cents, availableAmountCents: cents, status: 'AUTHORIZED', provider: 'PEANPE', createdByUserId: by,
      },
    });
    await tx.$executeRaw`UPDATE payments SET "createdAt" = ${at}::timestamptz WHERE id = ${p.id}::uuid`;
    return p.id;
  });
}

/** Todas las páginas, de `limit` en `limit`, con las fechas dadas. */
async function allPages<T extends { id: string }>(
  load: (query: ReturnType<typeof q>) => Promise<{ items: T[]; nextCursor: string | null }>,
  raw: Record<string, unknown>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await load(q({ ...raw, ...(cursor ? { cursor } : {}) }));
    ids.push(...page.items.map((x) => x.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 20);
  return { ids, pages };
}

const E: Record<string, string> = {};
const P: Record<string, string> = {};
const C: Record<string, string> = {};

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, W, owner, lucia, carmen, otra, term } = await sys(async (tx) => {
    const v = (await tx.venue.create({ data: { name: `Panel ${r}`, slug: `panel-${r}` } })).id;
    const w = (await tx.venue.create({ data: { name: `Otro ${r}`, slug: `panel-otro-${r}` } })).id;
    const user = async (tenantId: string, role: 'OWNER' | 'OPERATOR', name: string) =>
      (await tx.user.create({ data: { tenantId, email: `pc-${name}-${r}@x.es`, passwordHash: 'x', role, displayName: name } })).id;
    return {
      V: v,
      W: w,
      owner: await user(v, 'OWNER', 'javi'),
      lucia: await user(v, 'OPERATOR', 'lucia'),
      carmen: await user(v, 'OPERATOR', 'carmen'),
      otra: await user(w, 'OPERATOR', 'otra'),
      term: (await tx.terminal.create({ data: { tenantId: v, externalId: `PC-${r}`, label: 'Barra' } })).id,
    };
  }));
  // Lucía: cinco comisiones en tres noches; dos en el mismo milisegundo (la base guarda microsegundos).
  E.oct = await earningAt(V, lucia, '2026-10-30T23:00:00.000000+00', 1000);
  E.nov10a = await earningAt(V, lucia, '2026-11-10T22:15:00.123456+00', 1100);
  E.nov10b = await earningAt(V, lucia, '2026-11-10T22:15:00.123400+00', 1200);
  E.nov12 = await earningAt(V, lucia, '2026-11-12T01:30:00.000000+00', 1300);
  E.nov18 = await earningAt(V, lucia, '2026-11-18T00:10:00.000000+00', 1400);
  // De otra compañera del local y de otra del otro local, a la vez: nunca salen.
  await earningAt(V, carmen, '2026-11-12T01:30:00.000000+00', 999);
  await earningAt(W, otra, '2026-11-12T01:30:00.000000+00', 999);
  P.oct = await payoutAt(V, lucia, '2026-10-31T10:00:00.000000+00', 1000);
  P.nov13 = await payoutAt(V, lucia, '2026-11-13T10:00:00.000000+00', 3750, { tx: 'ES-TRF-20261113-04', url: 'https://banco.example/j/4' });
  P.nov19 = await payoutAt(V, lucia, '2026-11-19T10:00:00.000000+00', 1400);
  await payoutAt(V, carmen, '2026-11-13T10:00:00.000000+00', 999);
  C.oct = await cobroAt(V, lucia, '2026-10-30T23:00:00.000000+00', 2000);
  C.nov12 = await cobroAt(V, lucia, '2026-11-12T01:30:00.000000+00', 2600);
  await cobroAt(V, carmen, '2026-11-12T01:30:00.000000+00', 999);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Historial» de sus ganancias', () => {
  it('todas, de una en una: cada una una vez y en orden (las del mismo milisegundo, por id)', async () => {
    const { ids, pages } = await inVenue(V, () => allPages((query) => controller.myEarningsHistory(jwt(lucia, V), query), { limit: 1 }));
    const sameMs = [E.nov10a!, E.nov10b!].sort().reverse();
    expect(ids).toEqual([E.nov18, E.nov12, ...sameMs, E.oct]);
    expect(pages).toBe(5);
  });

  it('entre dos fechas [desde, hasta): solo las de dentro', async () => {
    const { ids } = await inVenue(V, () =>
      allPages((query) => controller.myEarningsHistory(jwt(lucia, V), query), { limit: 2, from: '2026-11-10T07:00:00.000Z', to: '2026-11-17T07:00:00.000Z' }),
    );
    expect(new Set(ids)).toEqual(new Set([E.nov12, E.nov10a, E.nov10b]));
  });

  it('con el neto y la fecha de cada una; de otra compañera u otro local, nada', async () => {
    const page = await inVenue(V, () => controller.myEarningsHistory(jwt(lucia, V), q({ limit: 50 })));
    expect(page.items.find((e) => e.id === E.nov12)).toMatchObject({ netCents: 1300, createdAt: '2026-11-12T01:30:00.000Z', payoutId: null });
    expect(page.nextCursor).toBeNull();
    const other = await inVenue(W, () => controller.myEarningsHistory(jwt(otra, W), q({ limit: 50 })));
    expect(other.items.map((e) => e.netCents)).toEqual([999]);
  });
});

describe('«Pagos recibidos»', () => {
  it('por páginas, entre fechas y con el justificante', async () => {
    const all = await inVenue(V, () => allPages((query) => controller.myPayoutsHistory(jwt(lucia, V), query), { limit: 2 }));
    expect(all.ids).toEqual([P.nov19, P.nov13, P.oct]);
    const nov = await inVenue(V, () => controller.myPayoutsHistory(jwt(lucia, V), q({ limit: 50, from: '2026-11-01T07:00:00.000Z', to: '2026-11-19T07:00:00.000Z' })));
    expect(nov.items).toHaveLength(1);
    expect(nov.items[0]).toMatchObject({
      id: P.nov13,
      totalCents: 3750,
      externalTxId: 'ES-TRF-20261113-04',
      receiptUrl: 'https://banco.example/j/4',
      externalRail: 'SEPA_IBAN',
    });
  });
});

describe('«Cobros» con fechas', () => {
  it('solo los suyos de entre esas fechas, sin la noche', async () => {
    const page = await inVenue(V, () =>
      own.list(jwt(lucia, V), q({ limit: 50, from: '2026-11-11T07:00:00.000Z', to: '2026-11-12T07:00:00.000Z' })),
    );
    expect(page.items.map((c) => c.id)).toEqual([C.nov12]);
    expect(page).not.toHaveProperty('night');
  });
});

describe('«Te han pagado»', () => {
  const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
  const AUTH = Buffer.alloc(16, 1).toString('base64url');
  const FCM = `https://fcm.googleapis.com/fcm/send/panel-${r}`;
  const APPLE = `https://web.push.apple.com/panel-${r}`;
  const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });
  /** Los títulos de los avisos a ese móvil, con espacio normal (los importes llevan espacio duro, de Intl). */
  const hardSpaces = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g');
  const titles = (endpoint: string) => pushed.filter((p) => p.endpoint === endpoint).map((p) => p.payload.title.replace(hardSpaces, ' '));
  let X: string, boss: string, marta: string, nuria: string;

  /** Una comisión sin pagar de `cents` (el local de X paga al cierre: sin días de espera). */
  const unpaid = (operatorId: string, cents: number) => earningAt(X, operatorId, new Date(Date.now() - 60_000).toISOString(), cents);
  /** El aviso sale por detrás del pago: con la máquina cargada, 1 s (lo de serie) no llega. */
  const WAIT = { timeout: 5_000 };
  const rows = (endpoint: string) => sys((tx) => tx.staffPushSubscription.findMany({ where: { endpoint }, select: { userId: true, tenantId: true } }));

  beforeAll(async () => {
    ({ X, boss, marta, nuria } = await sys(async (tx) => {
      const x = (await tx.venue.create({ data: { name: `Aviso ${r}`, slug: `panel-aviso-${r}`, payoutHoldDays: 0 } })).id;
      const user = async (role: 'OWNER' | 'OPERATOR', name: string) =>
        (await tx.user.create({ data: { tenantId: x, email: `pc-${name}-${r}@x.es`, passwordHash: 'x', role, displayName: name } })).id;
      return { X: x, boss: await user('OWNER', 'jefe'), marta: await user('OPERATOR', 'marta'), nuria: await user('OPERATOR', 'nuria') };
    }));
  });

  it('la app sabe que está encendido y apunta este móvil a ella (otro local no lo ve)', async () => {
    expect(controller.myPushKey()).toEqual({ publicKey: VAPID.WEB_PUSH_VAPID_PUBLIC_KEY });
    await inVenue(X, () => controller.subscribePush(jwt(marta, X), subscription(FCM)));
    await inVenue(X, () => controller.subscribePush(jwt(marta, X), subscription(APPLE)));
    expect(await rows(FCM)).toEqual([{ userId: marta, tenantId: X }]);
    const seen = await inVenue(V, () => prisma.withTenant(V, (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM staff_push_subscriptions WHERE "userId" = ${marta}::uuid`));
    expect(seen).toEqual([{ n: 0 }]);
  });

  it('al apuntarle un pago: «Te han pagado 37,50 €» a sus dos móviles, abre «Ganancias»; el pago no espera', async () => {
    await unpaid(marta, 3_750);
    const paid = await inVenue(X, () => operators.createPayout(X, marta, boss, 'Noche del 18'));
    expect(paid.totalCents).toBe(3_750);
    await vi.waitFor(() => expect(titles(FCM)).toEqual(['Te han pagado 37,50 €']), WAIT);
    await vi.waitFor(() => expect(titles(APPLE)).toEqual(['Te han pagado 37,50 €']), WAIT);
    expect(pushed.find((p) => p.endpoint === FCM)?.payload.url).toBe('/?t=ganancias');
  });

  it('un móvil avisa a una sola persona: si otra lo activa, pasa a ella', async () => {
    await inVenue(X, () => controller.subscribePush(jwt(nuria, X), subscription(FCM)));
    expect(await rows(FCM)).toEqual([{ userId: nuria, tenantId: X }]);
    pushed.length = 0;
    await unpaid(marta, 1_000);
    await inVenue(X, () => operators.createPayout(X, marta, boss));
    await vi.waitFor(() => expect(titles(APPLE)).toEqual(['Te han pagado 10 €']), WAIT);
    expect(titles(FCM)).toEqual([]);
  });

  it('el móvil que ya no existe (410) se borra; «Quitar el aviso» lo quita', async () => {
    pushStatus = 410;
    await unpaid(marta, 500);
    await inVenue(X, () => operators.createPayout(X, marta, boss));
    await vi.waitFor(async () => expect(await rows(APPLE)).toEqual([]), WAIT);
    pushStatus = 201;
    await inVenue(X, () => controller.unsubscribePush(jwt(nuria, X), { endpoint: FCM }));
    expect(await rows(FCM)).toEqual([]);
  });

  it('sin claves VAPID: apagado (la app no lo ofrece y no se guarda nada)', async () => {
    const off = new OperatorsController(operators, new StaffPushService(prisma, sender, {}));
    expect(off.myPushKey()).toEqual({ publicKey: null });
    await expect(inVenue(X, () => off.subscribePush(jwt(marta, X), subscription(FCM)))).rejects.toMatchObject({ response: { code: 'PUSH_OFF' } });
    expect(await rows(FCM)).toEqual([]);
  });
});
