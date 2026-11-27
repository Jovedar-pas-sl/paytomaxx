import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { LIVE_CODE_RE } from '@nightpay/contracts';
import { createFakeRedis, type FakeRedis } from '../auth/testing/fake-redis';
import { WalletLiveCodeService } from './wallet-live-code.service';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const MERGED = '33333333-3333-4333-8333-333333333333';

function prismaFake() {
  const wallets = new Map<string, { mergedIntoId: string | null }>([
    [W1, { mergedIntoId: null }],
    [W2, { mergedIntoId: null }],
    [MERGED, { mergedIntoId: W1 }],
  ]);
  const tx = { clientWallet: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => wallets.get(where.id) ?? null) } };
  return { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
}

let redis: FakeRedis;
let service: WalletLiveCodeService;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-05T22:41:05Z'));
  redis = createFakeRedis();
  service = new WalletLiveCodeService(prismaFake() as never, redis as never);
});
afterEach(() => vi.useRealTimers());

describe('WalletLiveCodeService.issue', () => {
  it('OXC1: + 26 de Crockford, 60 s y el QR como data: con un <svg>', async () => {
    const issued = await service.issue(W1);
    expect(issued.code).toMatch(LIVE_CODE_RE);
    expect(issued.expiresIn).toBe(60);
    expect(issued.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(issued.qr.split(',')[1]!, 'base64').toString('utf8')).toContain('<svg');
  });

  it('1.000 códigos distintos, y ni las claves ni los valores de Redis llevan el código', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i += 1) codes.add((await service.issue(W1)).code);
    expect(codes.size).toBe(1000);
    const stored = await Promise.all(redis.keys().map(async (k) => `${k}=${await redis.get(k)}`));
    const sample = [...codes].slice(0, 50);
    for (const code of sample) {
      expect(stored.some((s) => s.includes(code) || s.includes(code.slice(5)))).toBe(false);
    }
    expect(redis.keys().filter((k) => k.startsWith('np:wlive:')).every((k) => /^np:wlive:[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it('un saldo sumado a otro: 409 WALLET_CLOSED sin tocar Redis', async () => {
    const err = await service.issue(MERGED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WALLET_CLOSED' });
    expect(redis.keys()).toEqual([]);
  });

  it('sin Redis: 503 TRY_LATER', async () => {
    const bare = new WalletLiveCodeService(prismaFake() as never, undefined);
    const err = await bare.issue(W1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'TRY_LATER' });
  });

  it('Redis que falla al darlo: 503 TRY_LATER', async () => {
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.issue(W1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('WalletLiveCodeService.peek', () => {
  it('a los 59 s vale; a los 61 s, no', async () => {
    const { code } = await service.issue(W1);
    vi.setSystemTime(Date.now() + 59_000);
    expect(await service.peek(code)).toEqual({ walletId: W1, grade: 'identify' });
    vi.setSystemTime(Date.now() + 2_000);
    expect(await service.peek(code)).toBeNull();
  });

  it('uno inventado, null', async () => {
    expect(await service.peek('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9')).toBeNull();
  });

  it('dropWallet mata los de ese saldo y no los de otro; uno nuevo tras anular vale', async () => {
    const a = await service.issue(W1);
    const b = await service.issue(W1);
    const other = await service.issue(W2);
    await service.dropWallet(W1);
    expect(await service.peek(a.code)).toBeNull();
    expect(await service.peek(b.code)).toBeNull();
    expect(await service.peek(other.code)).toEqual({ walletId: W2, grade: 'identify' });
    const fresh = await service.issue(W1);
    expect(await service.peek(fresh.code)).toEqual({ walletId: W1, grade: 'identify' });
  });

  it('sin su generación en Redis no vale, ni tras otra anulación', async () => {
    const { code } = await service.issue(W1);
    await redis.del(`np:wlive-gen:${W1}`);
    expect(await service.peek(code)).toBeNull();
    await service.dropWallet(W1);
    expect(await service.peek(code)).toBeNull();
  });

  it('sin Redis, lanza', async () => {
    const bare = new WalletLiveCodeService(prismaFake() as never, undefined);
    await expect(bare.peek('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9')).rejects.toThrow();
  });
});

describe('WalletLiveCodeService.dropWallet', () => {
  it('sin Redis o con Redis que falla, no lanza', async () => {
    await expect(new WalletLiveCodeService(prismaFake() as never, undefined).dropWallet(W1)).resolves.toBeUndefined();
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.dropWallet(W1)).resolves.toBeUndefined();
  });
});

describe('WalletLiveCodeService.offered', () => {
  const NOW = new Date('2026-11-27T22:00:00Z');
  const BIZ = 'eeeeeeee-0000-4000-8000-000000000001';
  const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const conn = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    scopes: ['wallet:balance', 'wallet:load'],
    pausedScopes: [] as string[],
    keyCreatedAt: new Date('2026-11-20T10:00:00Z'),
    keyResumedAt: null,
    lastUsedAt: null,
    partner: { allowedScopes: ['wallet:balance', 'wallet:load'] },
    venue: { walletGroup: null, businessId: BIZ, business: { taxId: 'B00000000' } },
    ...over,
  });
  function offerFake(c: ReturnType<typeof conn>, wallet: Record<string, unknown> = {}) {
    const tx = {
      clientWallet: { findUnique: vi.fn(async () => ({ tenantId: TENANT, walletGroup: null, mergedIntoId: null, blockedAt: null, ...wallet })) },
      venue: { findUnique: vi.fn(async () => ({ businessId: BIZ })) },
      partnerConnection: { findMany: vi.fn(async () => [c]) },
    };
    return { asSystem: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
  }

  beforeEach(() => {
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('PARTNER_API_MODE', 'test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('una conexión que vale y alcanza el saldo: sale', async () => {
    expect(await new WalletLiveCodeService(offerFake(conn()) as never).offered(W1, NOW)).toBe(true);
  });

  it('con sus permisos útiles en pausa, no; con uno de los dos aún vivo, sí', async () => {
    expect(await new WalletLiveCodeService(offerFake(conn({ pausedScopes: ['wallet:balance', 'wallet:load'] })) as never).offered(W1, NOW)).toBe(false);
    expect(await new WalletLiveCodeService(offerFake(conn({ scopes: ['wallet:load'], pausedScopes: ['wallet:load'] })) as never).offered(W1, NOW)).toBe(false);
    expect(await new WalletLiveCodeService(offerFake(conn({ pausedScopes: ['wallet:load'] })) as never).offered(W1, NOW)).toBe(true);
  });

  it('un saldo bloqueado: no sale', async () => {
    expect(await new WalletLiveCodeService(offerFake(conn(), { blockedAt: new Date() }) as never).offered(W1, NOW)).toBe(false);
  });

  it('si la base falla: no sale, no lanza y avisa en el log (solo el tipo)', async () => {
    const svc = new WalletLiveCodeService({ asSystem: vi.fn(async () => Promise.reject(new TypeError('consulta secreta'))) } as never);
    const warn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    expect(await svc.offered(W1, NOW)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(TypeError)'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secreta'));
  });
});
