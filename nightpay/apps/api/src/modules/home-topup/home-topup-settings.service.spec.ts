import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { HOME_TOPUP_CODE_RE } from '@nightpay/contracts';
import { queueTokenValid } from './home-topup-queue';
import { HomeTopUpSettingsService } from './home-topup-settings.service';

const VENUE = '11111111-1111-4111-8111-111111111111';
const OWNER = { userId: 'u-owner', email: 'duena@sala.test', tenantId: VENUE };

function make(o: { enabled?: boolean; code?: string | null; clashes?: number; problem?: boolean; fee?: boolean } = {}) {
  const row = { homeTopUpEnabled: o.enabled ?? false, homeTopUpCode: o.code === undefined ? null : o.code, homeTopUpGiftsEnabled: false };
  let clashes = o.clashes ?? 0;
  const gifts: unknown[] = [];
  const tx = {
    walletGift: { findMany: vi.fn(async () => gifts) },
    venue: {
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      update: vi.fn(async (args: { data: { homeTopUpCode?: string; homeTopUpEnabled?: boolean } }) => {
        if (args.data.homeTopUpCode && clashes > 0) {
          clashes -= 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }
        Object.assign(row, args.data);
        return { id: VENUE };
      }),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async () => undefined) };
  const state = {
    state: { paused: false, card: o.problem ? false : true, wallet: true, hasGateway: true, hasTerminal: true },
    serviceFee: { enabled: o.fee ?? false, cardBps: 1000, topUpBps: 1200 },
  };
  const homeTopUps = { venueState: vi.fn(async () => state) };
  const config = {
    get: vi.fn((k: string) =>
      k === 'NEXT_PUBLIC_API_URL' ? 'https://api.sala.test/v1' : k === 'COOKIE_SECRET' ? 'test-only-cookie-secret-with-32-characters' : undefined,
    ),
  };
  const service = new HomeTopUpSettingsService(prisma as never, audit as never, homeTopUps as never, config as never);
  return { service, row, tx, audit, gifts };
}

describe('Ajustes → «Cargar saldo desde casa»', () => {
  it('apagado de serie: sin enlace ni QR', async () => {
    const view = await make().service.view(VENUE);
    expect(view).toMatchObject({ enabled: false, url: null, qrPngDataUrl: null, problem: null, minCents: 1000, maxCents: 30000 });
  });

  it('al encender por primera vez se crea el código (al azar) y sale el enlace del API con su QR', async () => {
    const m = make();
    const view = await m.service.setEnabled(OWNER, true);
    expect(m.row.homeTopUpCode).toMatch(HOME_TOPUP_CODE_RE);
    expect(view.enabled).toBe(true);
    expect(view.url).toBe(`https://api.sala.test/r/${m.row.homeTopUpCode}`);
    expect(view.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(m.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue.home_topup.updated', payload: { before: { enabled: false }, after: { enabled: true } } }),
    );
    // Nunca el código en el registro.
    expect(JSON.stringify(m.audit.log.mock.calls)).not.toContain(m.row.homeTopUpCode ?? '-');
  });

  it('apagar conserva el código: al volver a encender, el mismo enlace', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    expect((await m.service.setEnabled(OWNER, false)).url).toBeNull();
    expect(m.row.homeTopUpCode).toBe('AbCdEfGhIjKlMnOp');
    expect((await m.service.setEnabled(OWNER, true)).url).toBe('https://api.sala.test/r/AbCdEfGhIjKlMnOp');
  });

  it('lo mismo otra vez no cambia nada ni deja registro', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    await m.service.setEnabled(OWNER, true);
    expect(m.tx.venue.update).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('«Enlace nuevo»: otro código (el de antes deja de valer); si chocara con el de otro local, otro', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp', clashes: 2 });
    const view = await m.service.rotate(OWNER);
    expect(m.row.homeTopUpCode).not.toBe('AbCdEfGhIjKlMnOp');
    expect(m.row.homeTopUpCode).toMatch(HOME_TOPUP_CODE_RE);
    expect(view.url).toBe(`https://api.sala.test/r/${m.row.homeTopUpCode}`);
    expect(m.tx.venue.update).toHaveBeenCalledTimes(3);
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'venue.home_topup.link_rotated', payload: {} }));
  });

  it('encendido pero sin «QR con tarjeta»: lo dice; con la comisión de las recargas, su %', async () => {
    const view = await make({ enabled: true, code: 'AbCdEfGhIjKlMnOp', problem: true, fee: true }).service.view(VENUE);
    expect(view.problem).toBe('methods');
    expect(view.serviceFeeBps).toBe(1200);
  });
});

describe('Ajustes → «Regalos» («Regala una noche»)', () => {
  it('apagado de serie; encender y apagar queda en el registro (y lo mismo otra vez, no)', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    expect((await m.service.view(VENUE)).giftsEnabled).toBe(false);
    expect((await m.service.setGifts(OWNER, true)).giftsEnabled).toBe(true);
    expect(m.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue.home_topup.gifts_updated', payload: { before: { enabled: false }, after: { enabled: true } } }),
    );
    m.audit.log.mockClear();
    await m.service.setGifts(OWNER, true);
    expect(m.audit.log).not.toHaveBeenCalled();
    expect((await m.service.setGifts(OWNER, false)).giftsEnabled).toBe(false);
  });

  it('los regalos pagados del local, los sin guardar primero y con su estado (sin nombre ni mensaje)', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    const now = Date.now();
    const at = (d: number) => new Date(now + d * 86_400_000);
    const wallet = (activated: boolean) => ({ pinHash: activated ? 'h' : null, _count: { passkeys: 0 } });
    m.gifts.push(
      { id: 'g1', createdAt: at(-1), expiresAt: at(89), claimedAt: null, payment: { amountCents: 5000 }, wallet: wallet(false) },
      { id: 'g2', createdAt: at(-100), expiresAt: at(-10), claimedAt: null, payment: { amountCents: 2500 }, wallet: wallet(false) },
      { id: 'g3', createdAt: at(-3), expiresAt: at(87), claimedAt: at(-2), payment: { amountCents: 10000 }, wallet: wallet(true) },
    );
    const view = await m.service.view(VENUE);
    expect(view.gifts.map((g) => [g.id, g.state, g.amountCents])).toEqual([
      ['g1', 'open', 5000],
      ['g2', 'expired', 2500],
      ['g3', 'claimed', 10000],
    ]);
    const query = m.tx.walletGift.findMany.mock.calls[0]![0] as { where: unknown; select: Record<string, unknown> };
    expect(query.where).toEqual({ tenantId: VENUE, payment: { status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } } });
    expect(query.select).not.toHaveProperty('toName');
    expect(query.select).not.toHaveProperty('message');
  });
});

describe('el cartel de la cola (B16)', () => {
  it('encendido: el enlace con el QR de esta noche (firmado), su PNG y hasta cuándo vale', async () => {
    const now = new Date('2026-11-10T22:00:00Z');
    const poster = await make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' }).service.queuePoster(VENUE, now);
    expect(poster!.url).toMatch(/^https:\/\/api\.sala\.test\/r\/AbCdEfGhIjKlMnOp\?cola=[0-9]+\.[A-Za-z0-9_-]{22}$/);
    const token = decodeURIComponent(poster!.url.split('cola=')[1]!);
    expect(queueTokenValid('test-only-cookie-secret-with-32-characters', VENUE, 'AbCdEfGhIjKlMnOp', token, now.getTime())).toBe(true);
    expect(poster!.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(poster!.validUntil).toBe('2026-11-11T10:00:00.000Z');
  });

  it('apagado: sin cartel', async () => {
    expect(await make({ enabled: false, code: 'AbCdEfGhIjKlMnOp' }).service.queuePoster(VENUE)).toBeNull();
  });
});
