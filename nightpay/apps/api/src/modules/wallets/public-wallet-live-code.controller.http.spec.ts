import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { PublicWalletLiveCodeController } from './public-wallet-live-code.controller';
import { WalletChargesService } from './wallet-charges.service';
import { WalletLiveCodeService } from './wallet-live-code.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { walletViewSetCookies } from './wallet-view-session';

const TOKEN = 'privateWalletToken0123456';
const SECRET = 'secreto-de-cookies-de-las-pruebas-0123456789';
const ISSUED = { code: 'OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9', qr: 'data:image/svg+xml;base64,PHN2Zz4=', expiresIn: 60 };
const charges = {
  walletRefByToken: vi.fn(async (token: string) => {
    if (token !== TOKEN) throw new NotFoundException('Saldo no encontrado');
    return { id: 'w1', shortCode: 'K7Q4M2' };
  }),
};
const passkeys = { hasPasskey: vi.fn(async () => false) };
const liveCodes = { issue: vi.fn(async () => ISSUED) };
let app: NestFastifyApplication;
const env = { ...process.env };

beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [PublicWalletLiveCodeController],
    providers: [
      { provide: WalletChargesService, useValue: charges },
      { provide: WalletPasskeysService, useValue: passkeys },
      { provide: WalletLiveCodeService, useValue: liveCodes },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : undefined) } },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, { PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test', EDITION: 'club' });
});
afterEach(() => {
  for (const k of ['PARTNER_API_ENABLED', 'PARTNER_API_MODE', 'EDITION']) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
});

const post = (url = `/w/${TOKEN}/live-code`, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers });

describe('POST /w/:token/live-code', () => {
  it('con la API de socios apagada, o en OxioParty: 404 sin dar código', async () => {
    process.env.PARTNER_API_ENABLED = 'false';
    expect((await post()).statusCode).toBe(404);
    Object.assign(process.env, { PARTNER_API_ENABLED: 'true', EDITION: 'party' });
    expect((await post()).statusCode).toBe(404);
    expect(liveCodes.issue).not.toHaveBeenCalled();
  });

  it('sin passkey: 200 { code, qr, expiresIn: 60 }, fuera de /v1, no-store y sin Referer', async () => {
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(ISSUED);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(liveCodes.issue).toHaveBeenCalledWith('w1');
    expect((await post(`/v1/w/${TOKEN}/live-code`)).statusCode).toBe(404);
  });

  it('con passkey: 401 WALLET_VIEW_REQUIRED sin sesión; 200 con ella (y alarga la sesión)', async () => {
    passkeys.hasPasskey.mockResolvedValue(true);
    const denied = await post();
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'WALLET_VIEW_REQUIRED' });
    expect(liveCodes.issue).not.toHaveBeenCalled();
    const cookie = walletViewSetCookies(SECRET, { id: 'w1', qrToken: TOKEN }, Date.now() - 60_000)[0]!.split(';')[0]!;
    const ok = await post(undefined, { cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(ISSUED);
    expect(ok.headers['set-cookie']).toBeDefined();
    passkeys.hasPasskey.mockResolvedValue(false);
  });

  it('un enlace desconocido: 404', async () => {
    expect((await post('/w/otroEnlaceQueNoExiste000/live-code')).statusCode).toBe(404);
    expect(liveCodes.issue).not.toHaveBeenCalled();
  });

  it('el tope por IP y por enlace, exacto (sin failOpen)', () => {
    expect(new Reflector().get('np:ip-rate-limit', PublicWalletLiveCodeController.prototype.issue)).toEqual({
      max: 300,
      windowSec: 60,
      scope: 'wallet-live-code',
      perKey: { param: 'token', max: 6 },
    });
  });
});
