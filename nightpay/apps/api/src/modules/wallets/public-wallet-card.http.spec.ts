import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const CARD = 'validCardToken0123456';
const PRIVATE = 'privateWalletToken0123456';
const wallet = { id: 'wallet-owner', qrToken: PRIVATE, status: 'ACTIVE', blockedAt: null };
const state = { code: 'ABC-123', balanceCents: 12345, status: 'ACTIVE', hasFaceId: true, hasPin: true, hasCard: true, closeRequested: false, merged: false, refund: null, cards: [], movements: [{ kind: 'topup', amountCents: 12345, label: 'Recarga privada', venueName: 'Local', at: new Date().toISOString(), ref: null }] };
const findUnique = vi.fn().mockResolvedValue({ id: 'card-id', status: 'ISSUED', walletId: wallet.id, wallet });
const keys = {
  hasPasskey: vi.fn().mockResolvedValue(true),
  challenge: vi.fn().mockResolvedValue({ challenge: 'random-challenge' }),
  verify: vi.fn(async (_scope, _host, response) => {
    if (response?.id !== 'valid-key') throw new ForbiddenException({ code: 'FACE_ID_FAILED' });
    return wallet.id;
  }),
};
let app: NestFastifyApplication;
beforeAll(async () => {
  const mod = await Test.createTestingModule({
    controllers: [PublicWalletController, PublicWalletCardController],
    providers: [WalletCardViewService,
      { provide: ConfigService, useValue: { get: () => 'test-only-cookie-secret-with-32-characters' } },
      { provide: PrismaService, useValue: { acrossVenues: (fn: (tx: unknown) => unknown) => fn({ walletCard: { findUnique } }) } },
      { provide: WalletPasskeysService, useValue: keys },
      { provide: WalletChargesService, useValue: { walletRefByToken: async () => ({ id: wallet.id, shortCode: 'ABC123' }), clientState: async () => state } },
      { provide: WalletTopUpService, useValue: { options: async () => ({ allowed: false, block: null }), paidProof: async () => null } },
      { provide: GoogleWalletService, useValue: { enabled: false } },
    ],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init(); await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });

describe('consulta NFC HTTP: ninguna información antes de verificar la llave', () => {
  it('el HTML público no expone el enlace privado ni el saldo; los GET alternativos tampoco', async () => {
    const api = app.getHttpAdapter().getInstance();
    for (const url of [`/w/card/${CARD}`, `/w/${PRIVATE}`]) {
      const r = await api.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.body).toContain('Consulta tu saldo');
      expect(r.body).not.toContain('ABC-123');
      expect(r.body).not.toContain('Recarga privada');
    }
    const r = await api.inject({ method: 'GET', url: `/w/card/${CARD}` });
    expect(r.body).not.toContain(PRIVATE);
    expect((await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state` })).statusCode).toBe(401);
  });
  it('solo la firma válida entrega una cookie, que habilita HTML y estado de ese saldo', async () => {
    const api = app.getHttpAdapter().getInstance();
    const bad = await api.inject({ method: 'POST', url: `/w/card/${CARD}/view`, payload: { response: { id: 'wrong-key' } } });
    expect(bad.statusCode).toBe(403); expect(bad.headers['set-cookie']).toBeUndefined();
    const good = await api.inject({ method: 'POST', url: `/w/card/${CARD}/view`, payload: { response: { id: 'valid-key' } } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ url: `/w/${PRIVATE}` });
    const cookie = String(good.headers['set-cookie']).split(';')[0]!;
    expect(good.headers['set-cookie']).toContain('HttpOnly');
    const unlocked = await api.inject({ method: 'GET', url: `/w/${PRIVATE}/state`, headers: { cookie } });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ balanceCents: 12345, movements: [{ label: 'Recarga privada' }] });
    const html = await api.inject({ method: 'GET', url: `/w/${PRIVATE}`, headers: { cookie } });
    expect(html.statusCode).toBe(200); expect(html.body).toContain('ABC-123');
    expect((await api.inject({ method: 'GET', url: `/v1/w/card/${CARD}` })).statusCode).toBe(404);
  });
});
