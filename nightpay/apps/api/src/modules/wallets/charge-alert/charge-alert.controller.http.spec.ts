import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
};
/** La sesión de consulta del saldo (tras desbloquear con su Face ID). */
const session = walletViewSetCookies(SECRET, { id: 'w1', qrToken: TOKEN }).map((c) => c.split(';')[0]).join('; ');
const alerts = { subscribe: vi.fn(async () => ({ ok: true })), unsubscribe: vi.fn(async () => ({ ok: true })), isSubscribed: vi.fn(async () => true) };
const at = new Date('2026-11-16T22:40:00Z');
const disputes = {
  view: vi.fn(async () => ({ state: 'ask', ref: 'C-0042', totalCents: 1_200, venueName: 'Sala Aurora', at })),
  dispute: vi.fn(async () => ({ state: 'done', ref: 'C-0042', totalCents: 1_200, venueName: 'Sala Aurora', at, blockedCards: 1, pinLocked: true })),
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
