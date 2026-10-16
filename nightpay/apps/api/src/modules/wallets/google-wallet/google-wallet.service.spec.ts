import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GoogleWalletService } from './google-wallet.service';
import { GOOGLE_OAUTH_TOKEN_URL, GOOGLE_WALLET_SAVE_URL } from './google-wallet-jwt';
import { linkHash } from './google-wallet-pass';
import type { FetchFn } from './google-wallet-client';
import type { DuePass } from './google-wallet-sync';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({
  type: 'service_account',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'wallet@oxiopay.iam.gserviceaccount.com',
});
const ISSUER = '3388000000012345678';
const TOKEN = 'tok-del-saldo-144bits';
const ENV: Record<string, string> = {
  GOOGLE_WALLET_ISSUER_ID: ISSUER,
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: SA,
  GOOGLE_WALLET_CLASS_SUFFIX: 'oxiopay_saldo',
  NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com',
};

function googleOk(replies: Array<[number, unknown?]> = []) {
  const api: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    if (url === GOOGLE_OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    api.push({ method: String(init.method), path: url.split('/walletobjects/v1')[1], body: JSON.parse(String(init.body)) });
    const [status, body] = replies.shift() ?? [200, {}];
    return new Response(JSON.stringify(body ?? {}), { status });
  });
  return { fetchFn, api };
}

/** Redis de mentira: SET NX con valor, INCR y el EVAL de soltar el candado. */
function fakeRedis() {
  const store = new Map<string, string | number>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ..._opts: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, n);
      return n;
    }),
    pexpire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _keys: number, key: string, value: string) => {
      if (store.get(key) !== value) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

function make(
  env: Record<string, string> = ENV,
  fetchFn?: FetchFn,
  wallet: Record<string, unknown> = {},
  redis = fakeRedis(),
) {
  const tx = {
    clientWallet: {
      findUnique: vi.fn().mockResolvedValue({
        qrToken: TOKEN,
        balanceCents: 20_000,
        status: 'ACTIVE',
        mergedIntoId: null,
        venue: { name: 'Luna Valencia' },
        ...wallet,
      }),
    },
  };
  const due: DuePass[] = [];
  const prisma = {
    asSystem: vi.fn(async (fn: (t: unknown) => unknown) => fn({ ...tx, $queryRaw: vi.fn().mockResolvedValue(due) })),
    walletPass: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
  };
  const charges = { walletRefByToken: vi.fn().mockResolvedValue({ id: 'w-1', shortCode: 'K7Q4M2' }) };
  const config = { get: (key: string) => env[key] };
  const svc = new GoogleWalletService(prisma as never, charges as never, config as never, redis as never, fetchFn);
  return { svc, prisma, charges, tx, due, redis };
}

function jwtClaims(saveUrl: string): Record<string, unknown> {
  const jwt = saveUrl.slice(GOOGLE_WALLET_SAVE_URL.length);
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

describe('sin configurar', () => {
  it('apagado: no se puede pedir el pase y el repaso no hace nada', async () => {
    const { svc, prisma, charges } = make({});
    expect(svc.enabled).toBe(false);
    await expect(svc.saveLink(TOKEN)).rejects.toThrow(NotFoundException);
    expect(charges.walletRefByToken).not.toHaveBeenCalled();
    await expect(svc.syncDue()).resolves.toEqual({ checked: 0, updated: 0, revoked: 0, failed: 0 });
    expect(prisma.asSystem).not.toHaveBeenCalled();
  });
});

describe('«Añadir a Google Wallet» (POST /w/:token/google-wallet)', () => {
  it('con el enlace del saldo: crea la clase y el pase en Google, lo apunta y da el enlace para guardarlo', async () => {
    const g = googleOk();
    const { svc, prisma, charges } = make(ENV, g.fetchFn);
    const { saveUrl } = await svc.saveLink(TOKEN);

    expect(charges.walletRefByToken).toHaveBeenCalledWith(TOKEN);
    expect(g.api.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /genericClass', 'POST /genericObject']);
    const object = g.api[1].body as { id: string; barcode: { value: string }; header: { defaultValue: { value: string } } };
    const objectId = `${ISSUER}.oxiopay_saldo-${linkHash(TOKEN).slice(0, 40)}`;
    expect(object.id).toBe(objectId);
    expect(object.barcode.value).toBe(`https://api.paytomaxx.com/w/${TOKEN}`);
    expect(object.header.defaultValue.value).toMatch(/^200,00\s€$/);

    // Se guarda el hash del enlace, nunca el enlace.
    const upsert = prisma.walletPass.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ objectId });
    expect(upsert.create).toMatchObject({
      walletId: 'w-1',
      provider: 'GOOGLE',
      objectId,
      tokenHash: linkHash(TOKEN),
      lastSyncedBalanceCents: 20_000,
      lastSyncedStatus: 'ACTIVE',
    });
    expect(JSON.stringify(upsert)).not.toContain(TOKEN);
    expect(upsert.update).toMatchObject({ revokedAt: null, lastSyncedBalanceCents: 20_000 });

    // El JWT solo nombra el pase y el dominio de la página; ni el enlace del saldo.
    expect(saveUrl.startsWith(GOOGLE_WALLET_SAVE_URL)).toBe(true);
    const claims = jwtClaims(saveUrl);
    expect(claims).toMatchObject({
      aud: 'google',
      typ: 'savetowallet',
      origins: ['https://api.paytomaxx.com'],
      payload: { genericObjects: [{ id: objectId, classId: `${ISSUER}.oxiopay_saldo` }] },
    });
    expect(saveUrl).not.toContain(TOKEN);
  });

  it('enlace que no existe → 404 (como el resto de /w) y no se llama a Google', async () => {
    const g = googleOk();
    const { svc, charges } = make(ENV, g.fetchFn);
    charges.walletRefByToken.mockRejectedValueOnce(new NotFoundException('Saldo no encontrado'));
    await expect(svc.saveLink('nope')).rejects.toThrow(NotFoundException);
    expect(g.fetchFn).not.toHaveBeenCalled();
  });

  it('saldo cerrado o sumado a otro → 409, sin pase', async () => {
    for (const wallet of [{ status: 'REFUNDED' }, { status: 'DEPLETED', mergedIntoId: 'w-2' }]) {
      const g = googleOk();
      const { svc, prisma } = make(ENV, g.fetchFn, wallet);
      await expect(svc.saveLink(TOKEN)).rejects.toThrow(ConflictException);
      expect(g.fetchFn).not.toHaveBeenCalled();
      expect(prisma.walletPass.upsert).not.toHaveBeenCalled();
    }
  });

  it('como mucho 5 toques por saldo y minuto (cada uno llama a Google) → 429', async () => {
    const g = googleOk();
    const { svc, redis } = make(ENV, g.fetchFn);
    for (let i = 0; i < 5; i += 1) await svc.saveLink(TOKEN);
    const err = await svc.saveLink(TOKEN).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    // La clave es del hash del enlace, no del enlace.
    const keys = [...redis.store.keys()];
    expect(keys.some((k) => k.startsWith('np:google-wallet-save:'))).toBe(true);
    expect(keys.join()).not.toContain(TOKEN);
  });

  it('sin Redis el límite por saldo no bloquea al cliente (queda el de la IP)', async () => {
    const g = googleOk();
    const redis = fakeRedis();
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
    const { svc } = make(ENV, g.fetchFn, {}, redis);
    await expect(svc.saveLink(TOKEN)).resolves.toHaveProperty('saveUrl');
  });

  it('Google no responde → 503 con un mensaje para el cliente y no se apunta nada', async () => {
    const g = googleOk([[200, {}], [500, { error: { message: 'backend error' } }]]);
    const { svc, prisma } = make(ENV, g.fetchFn);
    await expect(svc.saveLink(TOKEN)).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.walletPass.upsert).not.toHaveBeenCalled();
  });
});

describe('repaso (cola google-wallet-sync)', () => {
  function due(o: Partial<DuePass>): DuePass {
    return {
      id: 'p-1',
      objectId: `${ISSUER}.oxiopay_saldo-aaa`,
      lastSyncedBalanceCents: 20_000,
      lastSyncedStatus: 'ACTIVE',
      balanceCents: 5_000,
      status: 'ACTIVE',
      merged: false,
      sameLink: true,
      qrToken: TOKEN,
      venueName: 'Luna',
      ...o,
    };
  }

  it('saldo nuevo → PATCH del pase y se apunta lo enviado; enlace cambiado → se apaga', async () => {
    const g = googleOk();
    const { svc, prisma, due: rows } = make(ENV, g.fetchFn);
    rows.push(due({ id: 'p-1' }), due({ id: 'p-2', objectId: `${ISSUER}.oxiopay_saldo-bbb`, sameLink: false }));
    await expect(svc.syncDue()).resolves.toEqual({ checked: 2, updated: 1, revoked: 1, failed: 0 });

    const patches = g.api.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.path)).toEqual([
      `/genericObject/${ISSUER}.oxiopay_saldo-aaa`,
      `/genericObject/${ISSUER}.oxiopay_saldo-bbb`,
    ]);
    expect((patches[0].body as { header: { defaultValue: { value: string } } }).header.defaultValue.value).toMatch(/^50,00\s€$/);
    expect((patches[1].body as { state: string }).state).toBe('INACTIVE');
    expect(prisma.walletPass.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: expect.objectContaining({ lastSyncedBalanceCents: 5_000, lastSyncedStatus: 'ACTIVE' }),
    });
    expect(prisma.walletPass.update).toHaveBeenCalledWith({
      where: { id: 'p-2' },
      data: { revokedAt: expect.any(Date), lastAttemptAt: expect.any(Date) },
    });
  });

  it('un pase que falla no para el resto, no se marca como al día y pasa al final de la cola', async () => {
    const g = googleOk([[200, {}], [400, { error: { message: 'bad' } }], [200, {}]]);
    const { svc, prisma, due: rows } = make(ENV, g.fetchFn);
    rows.push(due({ id: 'p-1' }), due({ id: 'p-2', objectId: `${ISSUER}.oxiopay_saldo-bbb` }));
    // 1ª llamada: la clase; 2ª: el PATCH de p-1 falla; 3ª: el de p-2 va bien.
    await expect(svc.syncDue()).resolves.toEqual({ checked: 2, updated: 1, revoked: 0, failed: 1 });
    const updates = prisma.walletPass.update.mock.calls.map((c) => c[0]);
    // p-1: solo el intento (lo enviado no cambia: sigue pendiente); p-2: al día.
    expect(updates[0]).toEqual({ where: { id: 'p-1' }, data: { lastAttemptAt: expect.any(Date) } });
    expect(updates[1]).toMatchObject({ where: { id: 'p-2' }, data: { lastSyncedBalanceCents: 5_000 } });
  });

  it('Google no responde (5 fallos seguidos) → para y sigue en el próximo repaso', async () => {
    const replies: Array<[number, unknown?]> = [[200, {}], ...Array.from({ length: 10 }, (): [number, unknown] => [503, {}])];
    const g = googleOk(replies);
    const { svc, due: rows } = make(ENV, g.fetchFn);
    for (let i = 0; i < 10; i += 1) rows.push(due({ id: `p-${i}`, objectId: `${ISSUER}.oxiopay_saldo-${i}` }));
    await expect(svc.syncDue()).resolves.toEqual({ checked: 10, updated: 0, revoked: 0, failed: 5 });
    expect(g.api.filter((c) => c.method === 'PATCH')).toHaveLength(5);
  });

  it('un repaso a la vez: con otro en marcha (candado en Redis) no hace nada; al acabar lo suelta', async () => {
    const g = googleOk();
    const { svc, prisma, redis, due: rows } = make(ENV, g.fetchFn);
    rows.push(due({}));
    redis.store.set('np:google-wallet-sync:lock', 'otra-replica');
    await expect(svc.syncDue()).resolves.toEqual({ checked: 0, updated: 0, revoked: 0, failed: 0 });
    expect(prisma.asSystem).not.toHaveBeenCalled();
    redis.store.delete('np:google-wallet-sync:lock');
    await expect(svc.syncDue()).resolves.toMatchObject({ checked: 1, updated: 1 });
    expect(redis.store.has('np:google-wallet-sync:lock')).toBe(false);
  });

  it('el saldo devuelto pasa a INACTIVE', async () => {
    const g = googleOk();
    const { svc, due: rows } = make(ENV, g.fetchFn);
    rows.push(due({ status: 'REFUNDED', balanceCents: 0 }));
    await svc.syncDue();
    const patch = g.api.find((c) => c.method === 'PATCH');
    expect((patch?.body as { state: string }).state).toBe('INACTIVE');
  });
});
