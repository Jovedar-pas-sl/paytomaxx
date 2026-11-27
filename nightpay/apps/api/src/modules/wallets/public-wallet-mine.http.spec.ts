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

describe('GET /w/mine: la página de «Ver mi saldo» (idea 73, la puerta de la portada)', () => {
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });

  it('200 sin /v1, sin guardar, sin buscadores y sin decir de dónde viene', async () => {
    const r = await get('/w/mine');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.body).toContain('<meta name="robots" content="noindex">');
    expect((await get('/v1/w/mine')).statusCode).toBe(404);
  });

  it('«Tu saldo», cómo se abre, el botón con su Face ID y qué hacer si no se abre', async () => {
    const body = (await get('/w/mine')).body;
    expect(body).toContain('<title>Tu saldo</title>');
    expect(body).toContain('Desbloquea tu móvil para ver tu saldo.');
    expect(body).toContain('id="npMine"');
    expect(body).toContain('npMineShow(true);');
    expect(body).toContain('pkPrepare');
    expect(body).toContain('¿No se abre? Acerca tu ficha al móvil o abre el enlace de tu recarga.');
  });

  it('sin tokens ni datos de nadie: no lee ningún saldo ni la llave', async () => {
    const body = (await get('/w/mine', { cookie: 'np_lang=en' })).body;
    expect(body).toContain('<html lang="en"');
    expect(body).not.toContain('privateWalletToken');
    expect(body).not.toContain('oldWalletToken');
    expect(lookups()).toEqual(0);
    expect(noViewCookie(await get('/w/mine'))).toBe(true);
  });

  it('en los cuatro idiomas (?lang= o su cookie)', async () => {
    expect((await get('/w/mine?lang=en')).body).toContain('Unlock your phone to see your balance.');
    expect((await get('/w/mine?lang=fr')).body).toContain('<html lang="fr"');
    expect((await get('/w/mine?lang=pt')).body).toContain('<html lang="pt"');
  });
});

/** Ni la llave ni la base: la página no sabe de quién es el saldo. */
function lookups(): number {
  return keys.verify.mock.calls.length + keys.challenge.mock.calls.length + tx.clientWallet.findUnique.mock.calls.length + tx.$queryRaw.mock.calls.length;
}

/** Sin cookie de consulta: como mucho, la del idioma. */
function noViewCookie(r: { headers: Record<string, unknown> }): boolean {
  const cookies = ([] as string[]).concat((r.headers['set-cookie'] as string | string[] | undefined) ?? []);
  return cookies.every((c) => !c.includes('Path=/w/'));
}
