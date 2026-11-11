import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PublicWalletMineController } from './public-wallet-mine.controller';
import { WalletPasskeysService } from './wallet-passkeys.service';

// «Ver mi saldo» (pantallas sin salida): solo la llave del cliente dice qué
// saldo es; sin ella, ni el enlace ni la cookie de consulta.

const SECRET = 'test-only-cookie-secret-with-32-characters';
const wallets: Record<string, { mergedIntoId: string | null; qrToken: string }> = {
  'w-key': { mergedIntoId: null, qrToken: 'privateWalletToken0123456' },
  'w-old': { mergedIntoId: 'w-key', qrToken: 'oldWalletToken0123456789' },
};
const keys = {
  challenge: vi.fn().mockResolvedValue({ challenge: 'random-challenge' }),
  verify: vi.fn(),
};
const tx = {
  $queryRaw: vi.fn(async (_sql: TemplateStringsArray, id: string) => (wallets[id] ? [{ mergedIntoId: wallets[id]!.mergedIntoId }] : [])),
  clientWallet: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      wallets[where.id] ? { id: where.id, qrToken: wallets[where.id]!.qrToken } : null,
    ),
  },
};
let app: NestFastifyApplication;

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    controllers: [PublicWalletMineController],
    providers: [
      { provide: ConfigService, useValue: { get: () => SECRET } },
      { provide: PrismaService, useValue: { acrossVenues: (fn: (t: typeof tx) => unknown) => fn(tx) } },
      { provide: WalletPasskeysService, useValue: keys },
    ],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  keys.verify.mockImplementation(async (_scope: string, _host: string, response: { id?: string } | undefined) => {
    if (response?.id === 'key-of-old') return 'w-old';
    if (response?.id !== 'valid-key') throw new ForbiddenException({ code: 'FACE_ID_UNKNOWN' });
    return 'w-key';
  });
});

describe('«Ver mi saldo» con la llave del cliente', () => {
  it('el reto es solo para esto (sin /v1)', async () => {
    const r = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/w/mine/challenge', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(keys.challenge).toHaveBeenCalledWith('wallet-mine', expect.anything());
  });

  it('con su llave: el enlace de su saldo y la sesión de consulta de ese saldo', async () => {
    const r = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/w/mine', payload: { response: { id: 'valid-key' } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: '/w/privateWalletToken0123456' });
    expect(keys.verify).toHaveBeenCalledWith('wallet-mine', expect.anything(), { id: 'valid-key' });
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.includes('Path=/w/privateWalletToken0123456') && c.includes('HttpOnly'))).toBe(true);
  });

  it('una llave de un saldo que se sumó a otro lleva a aquel (donde está hoy el dinero)', async () => {
    const r = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/w/mine', payload: { response: { id: 'key-of-old' } } });
    expect(r.json()).toEqual({ url: '/w/privateWalletToken0123456' });
  });

  it('sin una llave buena: 403, sin enlace ni cookie', async () => {
    const r = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/w/mine', payload: { response: { id: 'otra' } } });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('privateWalletToken');
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});
