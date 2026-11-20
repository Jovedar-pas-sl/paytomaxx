import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { UNPREFIXED_ROUTES } from '../../common/http/unprefixed-routes';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { WalletPasskeysService } from '../wallets/wallet-passkeys.service';
import { walletViewSetCookies } from '../wallets/wallet-view-session';
import { PartyRefundsService } from './party-refunds.service';
import { PartyWalletController } from './party-wallet.controller';

/**
 * POST /w/:token/sobra por HTTP: quien solo tiene una foto del QR (el enlace)
 * pide a la tarjeta, pero no transferencia ni donar; esas dos van con el Face
 * ID del saldo verificado en la misma petición.
 */

const TOKEN = 'privateWalletToken0123456';
const WALLET = '6f1c2a4e-1b7d-4c3a-9e2f-0a1b2c3d4e5f';
const SECRET = 'secreto-de-las-cookies-de-pruebas-0123456789';
const IBAN = 'ES9121000418450200051332';
const HOLDER = 'Ana Pérez Núñez';
const VIEW = { deadline: null, open: true, allowDonation: true, balanceCents: 1300, available: { CARD: 0, TRANSFER: 0, DONATE: 0 }, faceId: false, locked: true, requests: [] };

const charges = { walletRefByToken: vi.fn(async () => ({ id: WALLET, shortCode: 'K7Q4M2' })) };
const passkeys = { hasPasskey: vi.fn(), verify: vi.fn(), assertOwner: vi.fn(), challenge: vi.fn() };
const refunds = { ask: vi.fn(async () => VIEW), view: vi.fn(async () => VIEW) };

/** La cookie de la sesión de consulta (la que deja el Face ID al abrir la página). */
const viewCookie = (): string =>
  walletViewSetCookies(SECRET, { id: WALLET, qrToken: TOKEN })[0]!
    .split(';')[0]!;

let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [PartyWalletController],
    providers: [
      { provide: WalletChargesService, useValue: charges },
      { provide: WalletPasskeysService, useValue: passkeys },
      { provide: PartyRefundsService, useValue: refunds },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : undefined) } },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('EDITION', 'party');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const ask = (payload: Record<string, unknown>, cookie?: string) =>
  app.inject({ method: 'POST', url: `/w/${TOKEN}/sobra`, payload, headers: { host: 'fiesta.example', ...(cookie ? { cookie } : {}) } });

describe('POST /w/:token/sobra: sin Face ID (solo el enlace, o una foto del QR)', () => {
  beforeEach(() => {
    passkeys.hasPasskey.mockResolvedValue(false);
    passkeys.assertOwner.mockResolvedValue(undefined);
  });

  it('a la tarjeta, sí: el dinero vuelve a la tarjeta que pagó', async () => {
    const res = await ask({ method: 'CARD', expectedAmountCents: 800 });
    expect(res.statusCode).toBe(200);
    expect(refunds.ask).toHaveBeenCalledWith(WALLET, { method: 'CARD', expectedAmountCents: 800 });
    expect(passkeys.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['transferencia', { method: 'TRANSFER', iban: IBAN, holderName: HOLDER }],
    ['donar', { method: 'DONATE' }],
  ])('%s, no: 409 REFUND_NEEDS_FACE_ID con el texto para la página, y no se pide nada', async (_what, payload) => {
    const res = await ask(payload);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'REFUND_NEEDS_FACE_ID', detail: 'Para transferencia o donar, activa Face ID o pásate por la taquilla.' });
    expect(refunds.ask).not.toHaveBeenCalled();
    // Ni con una llave de otro saldo pegada en la petición.
    const withKey = await ask({ ...payload, response: { id: 'llave-de-otro' } });
    expect(withKey.statusCode).toBe(409);
    expect(passkeys.verify).not.toHaveBeenCalled();
    expect(refunds.ask).not.toHaveBeenCalled();
  });
});

describe('POST /w/:token/sobra: los datos', () => {
  it('la transferencia sin titular: 400 REFUND_INVALID con el campo (la página dice cuál)', async () => {
    passkeys.hasPasskey.mockResolvedValue(true);
    passkeys.verify.mockResolvedValue(WALLET);
    const res = await ask({ method: 'TRANSFER', iban: IBAN, response: { id: 'su-llave' } }, viewCookie());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'REFUND_INVALID', field: 'holderName', reason: 'holderName' });
    expect(refunds.ask).not.toHaveBeenCalled();
  });
});

describe('POST /w/:token/sobra: con Face ID', () => {
  beforeEach(() => {
    passkeys.hasPasskey.mockResolvedValue(true);
  });

  it('transferencia y donar con su llave verificada en esa petición (atada a «sobra» y a este saldo)', async () => {
    passkeys.verify.mockResolvedValue(WALLET);
    for (const payload of [{ method: 'TRANSFER', iban: IBAN, holderName: HOLDER }, { method: 'DONATE' }]) {
      const res = await ask({ ...payload, response: { id: 'su-llave' } }, viewCookie());
      expect(res.statusCode).toBe(200);
    }
    expect(passkeys.verify).toHaveBeenCalledTimes(2);
    expect(passkeys.verify).toHaveBeenCalledWith(`sobra:${WALLET}`, 'fiesta.example', { id: 'su-llave' });
    expect(refunds.ask).toHaveBeenCalledWith(WALLET, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER });
    expect(refunds.ask).toHaveBeenCalledWith(WALLET, { method: 'DONATE' });
  });

  it('sin la llave en la petición, o con la de otro saldo, no: 403 y no se pide nada', async () => {
    passkeys.verify.mockRejectedValueOnce(new ForbiddenException({ message: 'Confirma con Face ID', code: 'FACE_ID_REQUIRED' }));
    const none = await ask({ method: 'TRANSFER', iban: IBAN, holderName: HOLDER }, viewCookie());
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ code: 'FACE_ID_REQUIRED' });
    passkeys.verify.mockResolvedValueOnce('otro-saldo');
    const other = await ask({ method: 'DONATE', response: { id: 'llave-de-otro' } }, viewCookie());
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'FACE_ID_WRONG' });
    expect(refunds.ask).not.toHaveBeenCalled();
  });

  it('sin la sesión de la página (solo el enlace), ni se llega a pedir: 401', async () => {
    const res = await ask({ method: 'TRANSFER', iban: IBAN, holderName: HOLDER, response: { id: 'su-llave' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'WALLET_VIEW_REQUIRED' });
    expect(refunds.ask).not.toHaveBeenCalled();
  });

  it('a la tarjeta, con su llave como siempre', async () => {
    passkeys.assertOwner.mockResolvedValue(undefined);
    const res = await ask({ method: 'CARD', response: { id: 'su-llave' } }, viewCookie());
    expect(res.statusCode).toBe(200);
    expect(passkeys.assertOwner).toHaveBeenCalledWith(WALLET, `sobra:${WALLET}`, 'fiesta.example', { id: 'su-llave' });
  });
});
