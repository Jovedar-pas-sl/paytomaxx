import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { WalletChargesService } from './wallet-charges.service';
import { WalletTopUpService } from './wallet-topup.service';
import { GoogleWalletService } from './google-wallet/google-wallet.service';
import { WalletCardViewService } from './wallet-card-view.service';
import { PublicWalletController } from './public-wallet.controller';
import { PublicWalletCardController } from './public-wallet-card.controller';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { GoogleWalletController } from './google-wallet/google-wallet.controller';
import { WALLET_VIEW_IDLE_S, walletViewSetCookies } from './wallet-view-session';

const SECRET = 'test-only-cookie-secret-with-32-characters';
const CARD = 'validCardToken0123456';
const PRIVATE = 'privateWalletToken0123456';
const wallet = { id: 'wallet-owner', qrToken: PRIVATE, status: 'ACTIVE', blockedAt: null, shortCode: 'ABC123' };
const state = { code: 'ABC-123', balanceCents: 12345, status: 'ACTIVE', hasFaceId: true, hasPin: true, hasCard: true, closeRequested: false, merged: false, refund: null, cards: [], movements: [{ kind: 'topup', amountCents: 12345, label: 'Recarga privada', venueName: 'Local', at: new Date().toISOString(), ref: null }] };
const issued = { id: 'card-id', status: 'ISSUED', walletId: wallet.id, wallet };
const findUnique = vi.fn();
const keys = {
  hasPasskey: vi.fn().mockResolvedValue(true),
  challenge: vi.fn().mockResolvedValue({ challenge: 'random-challenge' }),
  verify: vi.fn(async (_scope, _host, response) => {
    if (response?.id !== 'valid-key') throw new ForbiddenException({ code: 'FACE_ID_FAILED' });
    return wallet.id;
  }),
};
const cookieAt = (ms: number) => walletViewSetCookies(SECRET, wallet, ms)[0]!.split(';')[0]!;
let app: NestFastifyApplication;
const saveLink = vi.fn(async () => ({ saveUrl: 'https://pay.google.com/gp/v/save/test-only' }));
const publicView = vi.fn(async () => state);
beforeAll(async () => {
  const mod = await Test.createTestingModule({
    controllers: [PublicWalletController, PublicWalletCardController, WalletsController, GoogleWalletController],
    providers: [WalletCardViewService,
      { provide: ConfigService, useValue: { get: () => SECRET } },
      { provide: PrismaService, useValue: { acrossVenues: (fn: (tx: unknown) => unknown) => fn({ walletCard: { findUnique } }) } },
      { provide: WalletPasskeysService, useValue: keys },
      { provide: WalletChargesService, useValue: { walletRefByToken: async () => ({ id: wallet.id, shortCode: 'ABC123' }), clientState: async () => state } },
      { provide: WalletTopUpService, useValue: { options: async () => ({ allowed: false, block: null }), paidProof: async () => null } },
      { provide: GoogleWalletService, useValue: { enabled: false, saveLink } },
      { provide: WalletsService, useValue: { getPublicByToken: publicView } },
    ],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init(); await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  keys.hasPasskey.mockReset().mockResolvedValue(true);
  findUnique.mockReset().mockResolvedValue(issued);
});

describe('consulta NFC HTTP: ninguna información antes de verificar la llave', () => {
  it('las rutas alternativas tampoco revelan saldo ni permiten crear un pase sin desbloquear', async () => {
    const api = app.getHttpAdapter().getInstance();
    for (const headers of [{}, { cookie: 'npwv_invalid=invalid' }]) {
      const legacy = await api.inject({ method: 'GET', url: `/v1/wallets/public/${PRIVATE}`, headers });
      expect(legacy.statusCode).toBe(401);
      expect(legacy.body).not.toContain('Recarga privada');
      expect((await api.inject({ method: 'POST', url: `/w/${PRIVATE}/google-wallet`, payload: {}, headers })).statusCode).toBe(401);
    }
    expect(saveLink).not.toHaveBeenCalled();
    expect(publicView).not.toHaveBeenCalled();
  });

  it('la misma sesión de consulta habilita todas las vías y 15 minutos sin actividad las cierran', async () => {
    const api = app.getHttpAdapter().getInstance();
    for (const request of [{ method: 'GET' as const, url: `/v1/wallets/public/${PRIVATE}` }, { method: 'POST' as const, url: `/w/${PRIVATE}/google-wallet`, payload: {} }]) {
      expect((await api.inject({ ...request, headers: { cookie: cookieAt(Date.now()) } })).statusCode).toBe(200);
      const idle = cookieAt(Date.now() - (WALLET_VIEW_IDLE_S + 1) * 1000);
      expect((await api.inject({ ...request, headers: { cookie: idle } })).statusCode).toBe(401);
    }
  });

  it('el enlace privado sin passkey conserva la primera activación existente', async () => {
    keys.hasPasskey.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const api = app.getHttpAdapter().getInstance();
    expect((await api.inject({ method: 'GET', url: `/v1/wallets/public/${PRIVATE}` })).statusCode).toBe(200);
    expect((await api.inject({ method: 'POST', url: `/w/${PRIVATE}/google-wallet`, payload: {} })).statusCode).toBe(200);
  });

  it('el HTML público no expone el enlace privado ni el saldo', async () => {
    const api = app.getHttpAdapter().getInstance();
    for (const url of [`/w/card/${CARD}`, `/w/${PRIVATE}`]) {
      const r = await api.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.body).toContain('Consulta tu saldo');
      expect(r.body).not.toContain('ABC-123');
      expect(r.body).not.toContain('Recarga privada');
      expect(r.body).not.toContain('123,45');
    }
    const r = await api.inject({ method: 'GET', url: `/w/card/${CARD}` });
    expect(r.body).not.toContain(PRIVATE);
    expect((await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state` })).statusCode).toBe(401);
  });

  it('solo la firma válida entrega la sesión, en las rutas de ese saldo, y habilita HTML y estado', async () => {
    const api = app.getHttpAdapter().getInstance();
    const bad = await api.inject({ method: 'POST', url: `/w/card/${CARD}/view`, payload: { response: { id: 'wrong-key' } } });
    expect(bad.statusCode).toBe(403); expect(bad.headers['set-cookie']).toBeUndefined();
    const good = await api.inject({ method: 'POST', url: `/w/card/${CARD}/view`, payload: { response: { id: 'valid-key' } } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ url: `/w/${PRIVATE}` });
    const set = good.headers['set-cookie'] as string[];
    expect(set).toHaveLength(2);
    expect(set[0]).toContain(`Path=/w/${PRIVATE}; Max-Age=${WALLET_VIEW_IDLE_S}; HttpOnly; SameSite=Strict`);
    expect(set[1]).toContain(`Path=/v1/wallets/public/${PRIVATE};`);
    const cookie = set[0]!.split(';')[0]!;
    const unlocked = await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state`, headers: { cookie } });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ balanceCents: 12345, movements: [{ label: 'Recarga privada' }] });
    const html = await api.inject({ method: 'GET', url: `/w/${PRIVATE}`, headers: { cookie } });
    expect(html.statusCode).toBe(200); expect(html.body).toContain('ABC-123');
    expect((await api.inject({ method: 'GET', url: `/v1/w/card/${CARD}` })).statusCode).toBe(404);
  });

  it('la página mirando su estado alarga la sesión: tras 6 minutos sigue abierta y se renueva', async () => {
    const api = app.getHttpAdapter().getInstance();
    const old = cookieAt(Date.now() - 6 * 60 * 1000);
    for (const url of [`/w/${PRIVATE}/state`, `/w/${PRIVATE}`]) {
      const r = await api.inject({ method: 'GET', url, headers: { cookie: old } });
      expect(r.statusCode).toBe(200);
      const renewed = r.headers['set-cookie'] as string[];
      expect(renewed).toHaveLength(2);
      expect(renewed[0]).toContain(`Path=/w/${PRIVATE};`);
      // La renovada vale sola (otros 15 minutos desde ahora).
      expect((await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state`, headers: { cookie: renewed[0]!.split(';')[0]! } })).statusCode).toBe(200);
    }
    // Recién emitida: no se reescribe en cada consulta.
    const fresh = await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state`, headers: { cookie: cookieAt(Date.now()) } });
    expect(fresh.headers['set-cookie']).toBeUndefined();
  });
});
