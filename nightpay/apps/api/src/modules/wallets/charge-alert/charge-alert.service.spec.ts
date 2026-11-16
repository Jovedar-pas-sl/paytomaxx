import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MAX_PUSH_FAILS, MAX_SUBSCRIPTIONS_PER_WALLET, PUSH_ATTEMPTS, ChargeAlertService, chargePushPayload, type ChargePushPayload } from './charge-alert.service';
import { notMeChargeId, verifyNotMeToken } from './not-me-token';
import type { PushSender } from './push-sender';

const CHARGE = '11111111-2222-4333-8444-555555555555';
const WALLET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VENUE = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 's'.repeat(40);
const ENV = {
  WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es',
  JWT_SECRET: SECRET,
};
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 1).toString('base64url');
const FCM = 'https://fcm.googleapis.com/fcm/send/movil-1';
/** Los importes llevan espacio fino (Intl): se comparan con espacio normal. */
const THIN_SPACES = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g');
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(THIN_SPACES, ' ')) as T;

function sub(over: Partial<{ id: string; endpoint: string; lang: string; failCount: number }> = {}) {
  return { id: 'sub-1', endpoint: FCM, p256dh: P256DH, auth: AUTH, lang: 'es', failCount: 0, ...over };
}

function harness(opts: { subs?: ReturnType<typeof sub>[]; status?: string; sender?: PushSender; env?: Record<string, string> } = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ mergedIntoId: null }]),
    walletChargeRequest: {
      findUnique: vi.fn(async () => ({ id: CHARGE, tenantId: VENUE, walletId: WALLET, status: opts.status ?? 'ACCEPTED', amountCents: 1_000, tipCents: 200, ref: 42 })),
    },
    venue: { findUnique: vi.fn(async () => ({ name: 'Sala Aurora' })) },
    clientWallet: { findUnique: vi.fn(async () => ({ tenantId: VENUE, balanceCents: 3_800, qrToken: 'tokEnlaceDelSaldo1234' })) },
    walletPushSubscription: {
      findMany: vi.fn(async (args: { skip?: number }) => (args.skip !== undefined ? [] : (opts.subs ?? [sub()]))),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const sender = opts.sender ?? vi.fn<PushSender>(async () => ({ statusCode: 201 }));
  const svc = new ChargeAlertService(prisma as never, sender, (opts.env ?? ENV) as never);
  svc.sleep = vi.fn(async () => undefined);
  return { svc, tx, prisma, sender };
}

describe('«Aviso en cada cobro»: apagado sin claves', () => {
  it('sin claves VAPID no ofrece nada ni manda nada', async () => {
    const { svc, sender, prisma } = harness({ env: { JWT_SECRET: SECRET } });
    expect(svc.publicKey).toBeNull();
    expect(svc.enabled).toBe(false);
    svc.chargePaid(CHARGE);
    expect(await svc.notifyCharge(CHARGE)).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect(prisma.acrossVenues).not.toHaveBeenCalled();
    await expect(svc.subscribe(WALLET, {}, 'es')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('«Aviso en cada cobro»: apuntarse', () => {
  it('guarda el navegador en el saldo (con su idioma) y deja como mucho unos pocos', async () => {
    const { svc, tx } = harness();
    tx.walletPushSubscription.findMany.mockResolvedValueOnce([{ id: 'viejo' }] as never);
    await svc.subscribe(WALLET, { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } }, 'en');
    expect(tx.walletPushSubscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { walletId_endpoint: { walletId: WALLET, endpoint: FCM } },
      create: expect.objectContaining({ tenantId: VENUE, walletId: WALLET, lang: 'en' }),
    }));
    expect(tx.walletPushSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: MAX_SUBSCRIPTIONS_PER_WALLET }));
    expect(tx.walletPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['viejo'] } } });
  });

  it('una dirección que no es de un navegador: 400 y no se guarda', async () => {
    const { svc, tx } = harness();
    await expect(svc.subscribe(WALLET, { endpoint: 'https://intranet.local/x', keys: { p256dh: P256DH, auth: AUTH } }, 'es')).rejects.toMatchObject({
      response: { code: 'PUSH_INVALID' },
    });
    expect(tx.walletPushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('quitarlo borra solo este navegador de este saldo', async () => {
    const { svc, tx } = harness();
    await svc.unsubscribe(WALLET, { endpoint: FCM });
    expect(tx.walletPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { walletId: WALLET, endpoint: FCM } });
  });
});

describe('«Aviso en cada cobro»: mandar', () => {
  it('importe (con propina), local y saldo que queda; «No he sido yo» firmado para este cobro y saldo', async () => {
    const { svc, sender, tx } = harness();
    expect(await svc.notifyCharge(CHARGE)).toBe(1);
    const [target, raw, options] = vi.mocked(sender).mock.calls[0]!;
    expect(target).toEqual({ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } });
    expect(options).toMatchObject({ ttlSeconds: 43_200, vapid: { subject: 'mailto:soporte@ejemplo.es' } });
    const payload = plain(JSON.parse(raw) as ChargePushPayload);
    expect(payload).toMatchObject({ title: 'Se han cobrado 12 €', body: 'En Sala Aurora · te quedan 38 €', tag: `cobro-${CHARGE}`, url: '/w/tokEnlaceDelSaldo1234', notMeLabel: 'No he sido yo' });
    const token = payload.notMeUrl.replace('/w/no/', '');
    expect(notMeChargeId(token)).toBe(CHARGE);
    expect(verifyNotMeToken(token, WALLET, Date.now(), SECRET)).toBe('ok');
    // Nada del personal: no se lee quién cobró.
    expect(JSON.stringify(tx.walletChargeRequest.findUnique.mock.calls[0])).not.toContain('requestedByUserId');
    expect(tx.walletPushSubscription.updateMany).toHaveBeenCalledWith({ where: { id: 'sub-1' }, data: { failCount: 0, lastSentAt: expect.any(Date) } });
  });

  it('cada navegador en su idioma; el mismo navegador apuntado dos veces, un solo aviso', async () => {
    const { svc, sender } = harness({ subs: [sub({ lang: 'en' }), sub({ id: 'sub-2' }), sub({ id: 'sub-3', endpoint: 'https://web.push.apple.com/iphone', lang: 'xx' })] });
    expect(await svc.notifyCharge(CHARGE)).toBe(2);
    const titles = vi.mocked(sender).mock.calls.map((c) => plain((JSON.parse(c[1]) as ChargePushPayload).title));
    expect(titles).toEqual(expect.arrayContaining(['€12 charged', 'Se han cobrado 12 €']));
    expect(titles).toHaveLength(2);
  });

  it('un cobro que no está pagado no avisa', async () => {
    const { svc, sender } = harness({ status: 'CANCELED' });
    expect(await svc.notifyCharge(CHARGE)).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it('reintentos cortos si el servicio falla o no contesta; luego entregado', async () => {
    const sender = vi.fn<PushSender>()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce({ statusCode: 201 });
    const { svc } = harness({ sender });
    expect(await svc.notifyCharge(CHARGE)).toBe(1);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(svc.sleep).toHaveBeenCalledTimes(2);
  });

  it('404/410: el navegador ya no existe y se borra (en todos sus saldos), sin reintentar', async () => {
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 410 }));
    const { svc, tx } = harness({ sender });
    expect(await svc.notifyCharge(CHARGE)).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(tx.walletPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { endpoint: FCM } });
  });

  it('otro error (400, 403…) no se reintenta: cuenta un fallo; muchos seguidos, se quita', async () => {
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 403 }));
    const { svc, tx } = harness({ sender });
    await svc.notifyCharge(CHARGE);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(tx.walletPushSubscription.updateMany).toHaveBeenCalledWith({ where: { id: 'sub-1' }, data: { failCount: { increment: 1 } } });
    const tired = harness({ sender, subs: [sub({ failCount: MAX_PUSH_FAILS - 1 })] });
    await tired.svc.notifyCharge(CHARGE);
    expect(tired.tx.walletPushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
  });

  it('se rinde tras los intentos (sin lanzar)', async () => {
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 500 }));
    const { svc } = harness({ sender });
    expect(await svc.notifyCharge(CHARGE)).toBe(0);
    expect(sender).toHaveBeenCalledTimes(PUSH_ATTEMPTS);
  });

  it('chargePaid no espera al servicio de avisos ni lanza aunque todo falle', async () => {
    let release: (v: { statusCode: number }) => void = () => undefined;
    const sender = vi.fn<PushSender>(() => new Promise((resolve) => { release = resolve; }));
    const { svc } = harness({ sender });
    const before = Date.now();
    expect(() => svc.chargePaid(CHARGE)).not.toThrow();
    expect(Date.now() - before).toBeLessThan(50);
    await vi.waitFor(() => expect(sender).toHaveBeenCalled());
    release({ statusCode: 201 });

    const broken = harness();
    broken.prisma.acrossVenues.mockRejectedValue(new Error('base caída'));
    expect(() => broken.svc.chargePaid(CHARGE)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('el texto del aviso', () => {
  it('sin nombre del local, solo el saldo', () => {
    const p = plain(chargePushPayload({ lang: 'es', chargeId: CHARGE, totalCents: 1_250, balanceCents: 0, venueName: '  ', walletPath: '/w/t', notMePath: '/w/no/t' }));
    expect(p.title).toBe('Se han cobrado 12,50 €');
    expect(p.body).toBe('Te quedan 0 €');
  });
});
