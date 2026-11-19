import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UNPREFIXED_ROUTES } from '../../../common/http/unprefixed-routes';
import { WalletChargesService } from '../wallet-charges.service';
import { WalletPasskeysService } from '../wallet-passkeys.service';
import { PublicChargeAlertController } from './charge-alert.controller';
import { ChargeAlertService } from './charge-alert.service';
import { ChargeDisputeService } from './charge-dispute.service';
import { walletViewSetCookies } from '../wallet-view-session';

const TOKEN = 'privateWalletToken0123456';
const NOT_ME = 'eyJjIjoiMSJ9.firmaFirmaFirmaFirmaFirmaFirmaFirmaFirmaFirma12';
const charges = { walletRefByToken: vi.fn(async () => ({ id: 'w1', shortCode: 'K7Q4M2' })) };
const SECRET = 'secreto-de-pruebas-0123456789abcdef';
const passkeys = {
  hasPasskey: vi.fn(async () => true),
  challenge: vi.fn(async () => ({ challenge: 'reto' })),
  verify: vi.fn(async () => 'w1'),
  /** Como el de verdad: sin Face ID no pide nada; con él, la llave tiene que ser de este saldo. */
  assertOwner: vi.fn(async (walletId: string, scope: string, host: string | undefined, response: unknown) => {
    if (!(await passkeys.hasPasskey())) return;
    if ((await passkeys.verify(scope, host, response)) !== walletId) throw new ForbiddenException({ code: 'FACE_ID_WRONG' });
  }),
};
/** La sesión de consulta del saldo (tras desbloquear con su Face ID). */
const session = walletViewSetCookies(SECRET, { id: 'w1', qrToken: TOKEN }).map((c) => c.split(';')[0]).join('; ');
const alerts = { subscribe: vi.fn(async () => ({ ok: true })), unsubscribe: vi.fn(async () => ({ ok: true })), isSubscribed: vi.fn(async () => true) };
const at = new Date('2026-11-16T22:40:00Z');
const disputes = {
  view: vi.fn(async () => ({ state: 'ask', ref: 'C-0042', totalCents: 1_200, venueName: 'Sala Aurora', at })),
  dispute: vi.fn(async () => ({ state: 'done', ref: 'C-0042', totalCents: 1_200, venueName: 'Sala Aurora', at, blockedCards: 1, pinLocked: true })),
  linkFor: vi.fn(async () => `/w/no/${NOT_ME}`),
};
let app: NestFastifyApplication;

beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [PublicChargeAlertController],
    providers: [
      { provide: WalletChargesService, useValue: charges },
      { provide: WalletPasskeysService, useValue: passkeys },
      { provide: ConfigService, useValue: { get: () => SECRET } },
      { provide: ChargeAlertService, useValue: alerts },
      { provide: ChargeDisputeService, useValue: disputes },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('«Aviso en cada cobro»: rutas del cliente (fuera de /v1)', () => {
  it('el service worker (JS, se vuelve a pedir) y el manifiesto con el saldo como inicio', async () => {
    const sw = await app.inject({ method: 'GET', url: '/w/aviso-sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['content-type']).toContain('application/javascript');
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.body).toContain("addEventListener('push'");
    const m = await app.inject({ method: 'GET', url: `/w/${TOKEN}/manifest.webmanifest` });
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toContain('application/manifest+json');
    expect(m.json()).toMatchObject({ start_url: `/w/${TOKEN}`, scope: '/w/', display: 'standalone' });
    expect((await app.inject({ method: 'GET', url: '/w/no%20vale/manifest.webmanifest' })).statusCode).toBe(404);
  });

  it('apuntarse: con la sesión del saldo Y su Face ID o huella (reto atado a «aviso» y a este saldo)', async () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };
    const ch = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso/challenge`, headers: { host: 'api.example' } });
    expect(ch.statusCode).toBe(200);
    expect(passkeys.challenge).toHaveBeenCalledWith('aviso:w1', 'api.example');
    const on = await app.inject({
      method: 'POST', url: `/w/${TOKEN}/aviso`, payload: { subscription: sub, response: { id: 'llave' } }, headers: { cookie: `${session}; np_lang=fr`, host: 'api.example' },
    });
    expect(on.statusCode).toBe(200);
    expect(passkeys.verify).toHaveBeenCalledWith('aviso:w1', 'api.example', { id: 'llave' });
    expect(alerts.subscribe).toHaveBeenCalledWith('w1', sub, 'fr');
    const state = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso/estado`, payload: { endpoint: sub.endpoint }, headers: { cookie: session } });
    expect(state.json()).toEqual({ on: true });
    const off = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso/off`, payload: { endpoint: sub.endpoint }, headers: { cookie: session } });
    expect(off.statusCode).toBe(200);
    expect(alerts.unsubscribe).toHaveBeenCalledWith('w1', { endpoint: sub.endpoint });
    expect((await app.inject({ method: 'POST', url: `/v1/w/${TOKEN}/aviso`, payload: {} })).statusCode).toBe(404);
  });

  it('con solo el enlace privado no se apunta nadie: sin Face ID 409, sin sesión 401, llave de otro saldo 403', async () => {
    passkeys.hasPasskey.mockResolvedValue(false);
    const ch = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso/challenge` });
    expect(ch.statusCode).toBe(409);
    expect(ch.json()).toMatchObject({ code: 'FACE_ID_NOT_SET' });
    const noKey = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso`, payload: { subscription: {} } });
    expect(noKey.statusCode).toBe(409);
    passkeys.hasPasskey.mockResolvedValue(true);
    expect((await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso`, payload: { subscription: {} } })).statusCode).toBe(401);
    passkeys.verify.mockResolvedValueOnce('otro-saldo');
    const wrong = await app.inject({ method: 'POST', url: `/w/${TOKEN}/aviso`, payload: { subscription: {}, response: {} }, headers: { cookie: session } });
    expect(wrong.statusCode).toBe(403);
    expect(alerts.subscribe).not.toHaveBeenCalled();
  });

  it('«No he sido yo»: mirar no bloquea; el formulario (text/plain, sin JS) confirma', async () => {
    const page = await app.inject({ method: 'GET', url: `/w/no/${NOT_ME}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('¿Has sido tú?');
    expect(disputes.view).toHaveBeenCalledWith(NOT_ME);
    expect(disputes.dispute).not.toHaveBeenCalled();

    const done = await app.inject({ method: 'POST', url: `/w/no/${NOT_ME}?lang=es`, headers: { 'content-type': 'text/plain' }, payload: '' });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Ficha y PIN bloqueados');
    expect(disputes.dispute).toHaveBeenCalledWith(NOT_ME);
  });
});

describe('«No he sido yo» desde los movimientos del saldo (/w)', () => {
  const CHARGE = '11111111-2222-4333-8444-555555555555';

  it('con Face ID: la sesión del saldo y su llave (reto atado a «no» y a este saldo) dan el enlace de su página', async () => {
    const ch = await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}/challenge`, headers: { host: 'api.example' } });
    expect(ch.statusCode).toBe(200);
    expect(passkeys.challenge).toHaveBeenCalledWith('no:w1', 'api.example');
    const out = await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}`, payload: { response: { id: 'llave' } }, headers: { cookie: session, host: 'api.example' } });
    expect(out.statusCode).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.json()).toEqual({ url: `/w/no/${NOT_ME}` });
    expect(passkeys.verify).toHaveBeenCalledWith('no:w1', 'api.example', { id: 'llave' });
    expect(disputes.linkFor).toHaveBeenCalledWith('w1', CHARGE);
    // Pedir el enlace no bloquea nada: se confirma en su página.
    expect(disputes.dispute).not.toHaveBeenCalled();
  });

  it('sin la sesión 401, sin la llave 403 y con la de otro saldo 403: no hay enlace', async () => {
    expect((await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}`, payload: { response: {} } })).statusCode).toBe(401);
    passkeys.verify.mockRejectedValueOnce(new ForbiddenException({ code: 'FACE_ID_REQUIRED' }));
    expect((await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}`, payload: {}, headers: { cookie: session } })).statusCode).toBe(403);
    passkeys.verify.mockResolvedValueOnce('otro-saldo');
    expect((await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}`, payload: { response: {} }, headers: { cookie: session } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/no-es-un-id`, payload: {}, headers: { cookie: session } })).statusCode).toBe(400);
    expect(disputes.linkFor).not.toHaveBeenCalled();
  });

  it('sin Face ID en el saldo basta el enlace privado (como el aviso); el reto da 409', async () => {
    passkeys.hasPasskey.mockResolvedValue(false);
    const ch = await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}/challenge` });
    expect(ch.statusCode).toBe(409);
    const out = await app.inject({ method: 'POST', url: `/w/${TOKEN}/no/${CHARGE}`, payload: {} });
    expect(out.statusCode).toBe(200);
    expect(passkeys.verify).not.toHaveBeenCalled();
    passkeys.hasPasskey.mockResolvedValue(true);
  });
});
