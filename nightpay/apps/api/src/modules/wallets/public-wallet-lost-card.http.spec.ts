import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { PublicWalletLostCardController } from './public-wallet-lost-card.controller';
import { WalletChargesService } from './wallet-charges.service';
import { WalletLostCardService } from './wallet-lost-card.service';

const TOKEN = 'privateWalletToken0123456';
const charges = {
  walletRefByToken: vi.fn(async () => ({ id: 'w1', shortCode: 'K7Q4M2' })),
  clientState: vi.fn(async () => ({ code: 'K7Q-4M2', hasCard: false, hasFaceId: true, balanceCents: 3000 })),
};
const lost = { challenge: vi.fn(async () => ({ challenge: 'reto' })), block: vi.fn(async () => ({ blockedCards: 1 })) };
let app: NestFastifyApplication;

beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [PublicWalletLostCardController],
    providers: [{ provide: WalletChargesService, useValue: charges }, { provide: WalletLostCardService, useValue: lost }],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('POST /w/:token/lost-nfc', () => {
  it('fuera de /v1: reto atado al saldo de ese enlace', async () => {
    const r = await app.inject({ method: 'POST', url: `/w/${TOKEN}/lost-nfc/challenge`, headers: { host: 'api.example' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ challenge: 'reto' });
    expect(lost.challenge).toHaveBeenCalledWith('w1', 'api.example');
    expect((await app.inject({ method: 'POST', url: `/v1/w/${TOKEN}/lost-nfc/challenge` })).statusCode).toBe(404);
  });

  it('con la firma: bloquea y devuelve el estado del saldo (ya sin NFC)', async () => {
    const r = await app.inject({ method: 'POST', url: `/w/${TOKEN}/lost-nfc`, payload: { response: { id: 'key' } }, headers: { host: 'api.example' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hasCard: false, balanceCents: 3000 });
    expect(lost.block).toHaveBeenCalledWith('w1', 'api.example', { id: 'key' });
    expect(charges.clientState).toHaveBeenCalledWith(TOKEN);
  });

  it('sin Face ID, firma mala o sin NFC: el error con su code y sin estado', async () => {
    for (const [error, status] of [
      [new ConflictException({ code: 'FACE_ID_NOT_SET' }), 409],
      [new ForbiddenException({ code: 'FACE_ID_WRONG' }), 403],
      [new ConflictException({ code: 'WALLET_NO_CARD' }), 409],
    ] as const) {
      lost.block.mockRejectedValueOnce(error);
      const r = await app.inject({ method: 'POST', url: `/w/${TOKEN}/lost-nfc`, payload: {} });
      expect(r.statusCode).toBe(status);
    }
    expect(charges.clientState).not.toHaveBeenCalled();
  });

  it('límite por IP en las dos rutas', () => {
    const reflector = new Reflector();
    for (const handler of [PublicWalletLostCardController.prototype.challenge, PublicWalletLostCardController.prototype.block]) {
      expect(reflector.get('np:ip-rate-limit', handler)).toEqual({ max: 20, windowSec: 60, scope: 'wallet-lost-nfc' });
    }
  });
});
