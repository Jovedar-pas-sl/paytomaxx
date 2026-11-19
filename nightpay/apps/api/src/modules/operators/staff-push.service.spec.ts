import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import type { PushSender } from '../wallets/charge-alert/push-sender';
import { MAX_SUBSCRIPTIONS_PER_USER, StaffPushService, payoutPushPayload } from './staff-push.service';

// «Te han pagado»: el aviso al móvil de la compañera cuando el local le paga.
// Sin base ni red: la base y el servicio de avisos son de mentira.

const USER = 'a1c3e5f7-2b4d-4e6f-8a0b-9c8d7e6f5a4b';
const VENUE = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const PAYOUT = 'f1e2d3c4-0000-4000-8000-000000000001';
const ENV = {
  WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es',
};
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 1).toString('base64url');
const FCM = 'https://fcm.googleapis.com/fcm/send/movil-1';
const APPLE = 'https://web.push.apple.com/movil-2';
/** Los importes llevan espacio duro (Intl): se comparan con espacio normal. */
const HARD_SPACES = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g');
const plain = (s: string) => s.replace(HARD_SPACES, ' ');

function sub(over: Partial<{ id: string; endpoint: string; failCount: number }> = {}) {
  return { id: 'sub-1', endpoint: FCM, p256dh: P256DH, auth: AUTH, failCount: 0, ...over };
}

function harness(opts: { subs?: ReturnType<typeof sub>[]; sender?: PushSender; env?: Record<string, string> } = {}) {
  const sql: Prisma.Sql[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push(Prisma.sql(strings, ...values));
      return 1;
    }),
    staffPushSubscription: {
      findMany: vi.fn(async (args: { skip?: number }) => (args.skip !== undefined ? [] : (opts.subs ?? [sub()]))),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const run = vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
  const prisma = { acrossVenues: run, withTenant: vi.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const sender = opts.sender ?? vi.fn<PushSender>(async () => ({ statusCode: 201 }));
  const svc = new StaffPushService(prisma as never, sender, (opts.env ?? ENV) as never);
  svc.sleep = vi.fn(async () => undefined);
  return { svc, tx, prisma, sender, sql };
}

describe('«Te han pagado»: el texto', () => {
  it('el importe con sus céntimos, nada del local ni de la persona, y abre «Ganancias»', () => {
    const p = payoutPushPayload(PAYOUT, 3_750);
    expect(plain(p.title)).toBe('Te han pagado 37,50 €');
    expect(p).toMatchObject({ tag: `pago-${PAYOUT}`, url: '/?t=ganancias' });
    expect(plain(payoutPushPayload(PAYOUT, 4_000).title)).toBe('Te han pagado 40 €');
  });
});

describe('«Te han pagado»: apagado sin claves', () => {
  it('sin claves VAPID no ofrece nada ni manda nada', async () => {
    const { svc, sender, prisma } = harness({ env: {} });
    expect(svc.publicKey).toBeNull();
    svc.payoutMade({ tenantId: VENUE, operatorId: USER, payoutId: PAYOUT, totalCents: 3_750 });
    expect(await svc.notifyPayout({ tenantId: VENUE, operatorId: USER, payoutId: PAYOUT, totalCents: 3_750 })).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect(prisma.withTenant).not.toHaveBeenCalled();
    await expect(svc.subscribe(USER, VENUE, { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } })).rejects.toMatchObject({
      response: { code: 'PUSH_OFF' },
    });
  });
});

describe('«Te han pagado»: apuntarse y quitarlo', () => {
  it('guarda el navegador para esa persona (si era de otra, pasa a esta) y deja como mucho unos pocos', async () => {
    const { svc, tx, sql } = harness();
    expect(svc.publicKey).toBe(ENV.WEB_PUSH_VAPID_PUBLIC_KEY);
    tx.staffPushSubscription.findMany.mockResolvedValueOnce([{ id: 'viejo' }] as never);
    await svc.subscribe(USER, VENUE, { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } });
    expect(sql[0]!.text).toContain('ON CONFLICT (endpoint) DO UPDATE');
    expect(sql[0]!.values).toEqual([VENUE, USER, FCM, P256DH, AUTH]);
    expect(tx.staffPushSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER }, skip: MAX_SUBSCRIPTIONS_PER_USER }));
    expect(tx.staffPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['viejo'] } } });
  });

  it('una dirección que no es de un servicio de avisos de navegador: 400 y no se guarda', async () => {
    const { svc, tx } = harness();
    for (const body of [{ endpoint: 'https://intranet.local/x', keys: { p256dh: P256DH, auth: AUTH } }, { endpoint: FCM, keys: { p256dh: 'x', auth: AUTH } }, null]) {
      const err = await svc.subscribe(USER, VENUE, body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err).toMatchObject({ response: { code: 'PUSH_INVALID' } });
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('quitarlo borra solo ese navegador de esa persona', async () => {
    const { svc, tx } = harness();
    await svc.unsubscribe(USER, { endpoint: FCM });
    expect(tx.staffPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, endpoint: FCM } });
    tx.staffPushSubscription.deleteMany.mockClear();
    await svc.unsubscribe(USER, { endpoint: 'no-es-una-url' });
    expect(tx.staffPushSubscription.deleteMany).not.toHaveBeenCalled();
  });
});

describe('«Te han pagado»: mandar el aviso', () => {
  const PAID = { tenantId: VENUE, operatorId: USER, payoutId: PAYOUT, totalCents: 3_750 };

  it('a cada móvil suyo, cifrado con su clave y firmado; solo los de esa persona y de su local', async () => {
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
    const { svc, tx, prisma } = harness({ subs: [sub(), sub({ id: 'sub-2', endpoint: APPLE })], sender });
    expect(await svc.notifyPayout(PAID)).toBe(2);
    expect(prisma.withTenant).toHaveBeenCalledWith(VENUE, expect.any(Function));
    expect(tx.staffPushSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER, tenantId: VENUE } }));
    const [target, payload, options] = sender.mock.calls[0]!;
    expect(target).toEqual({ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } });
    expect(plain(JSON.parse(payload).title)).toBe('Te han pagado 37,50 €');
    expect(options.vapid.publicKey).toBe(ENV.WEB_PUSH_VAPID_PUBLIC_KEY);
    expect(tx.staffPushSubscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sub-1' }, data: expect.objectContaining({ failCount: 0 }) }));
  });

  it('el navegador que ya no existe (410) se borra; un fallo suelto suma uno y se reintenta corto', async () => {
    const gone = vi.fn<PushSender>(async () => ({ statusCode: 410 }));
    const a = harness({ sender: gone });
    expect(await a.svc.notifyPayout(PAID)).toBe(0);
    expect(a.tx.staffPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    const down = vi.fn<PushSender>(async () => ({ statusCode: 503 }));
    const b = harness({ sender: down });
    expect(await b.svc.notifyPayout(PAID)).toBe(0);
    expect(down).toHaveBeenCalledTimes(3);
    expect(b.tx.staffPushSubscription.updateMany).toHaveBeenCalledWith({ where: { id: 'sub-1' }, data: { failCount: { increment: 1 } } });
  });

  it('el pago no espera al aviso ni falla por él', async () => {
    const broken = harness();
    broken.prisma.withTenant.mockRejectedValueOnce(new Error('base caída'));
    expect(() => broken.svc.payoutMade(PAID)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
