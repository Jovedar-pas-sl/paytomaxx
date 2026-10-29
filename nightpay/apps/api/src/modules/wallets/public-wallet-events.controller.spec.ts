import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PublicWalletEventsController } from './public-wallet-events.controller';
import { WalletStreamHub, STREAM_MAX_LIFETIME_MS } from '../wallet-events/wallet-stream.hub';
import { WALLET_VIEW_IDLE_S, walletViewSetCookies } from './wallet-view-session';

/**
 * GET /w/:token/events: la página del saldo se entera al momento de que su
 * saldo cambió (H-1). Misma protección que /state: el enlace y, con Face ID,
 * su sesión. Por aquí no va ningún dato: solo «cambió».
 */
const SECRET = 'secreto-de-cookies-de-las-pruebas-0123456789';
const WALLET = { id: '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01', qrToken: 'enlace-privado-0123456789' };

function setup(opts: { passkey?: boolean; missing?: boolean } = {}) {
  const charges = {
    walletRefByToken: vi.fn(async (token: string) => {
      if (opts.missing || token !== WALLET.qrToken) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
      return { id: WALLET.id, shortCode: 'K7Q4M2' };
    }),
  };
  const passkeys = { hasPasskey: vi.fn(async () => opts.passkey === true) };
  const config = { get: vi.fn(() => SECRET) };
  const hub = new WalletStreamHub();
  const controller = new PublicWalletEventsController(charges as never, passkeys as never, config as never, hub);
  return { controller, hub, charges };
}

function fakeReply() {
  const raw = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    chunks: [] as string[],
    ended: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      raw.statusCode = status;
      raw.headers = headers;
      return raw;
    },
    write(chunk: string) {
      raw.chunks.push(chunk);
      return true;
    },
    end() {
      raw.ended = true;
    },
  };
  const reply = {
    raw,
    hijacked: false,
    hijack() {
      reply.hijacked = true;
      return reply;
    },
    getHeaders: () => ({ 'x-content-type-options': 'nosniff', 'content-type': 'application/json' }),
  };
  return reply;
}

function fakeRequest(ip = '203.0.113.7') {
  const raw = Object.assign(new EventEmitter(), { socket: { remoteAddress: ip } });
  return { raw, headers: {}, ip, socket: { remoteAddress: ip } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /w/:token/events', () => {
  it('sin Face ID (el enlace basta): abre el canal de avisos, sin búfer de proxy ni caché, y dice «hola»', async () => {
    const { controller, hub } = setup();
    const reply = fakeReply();
    await controller.events(WALLET.qrToken, undefined, fakeRequest() as never, reply as never);
    expect(reply.hijacked).toBe(true);
    expect(reply.raw.statusCode).toBe(200);
    expect(reply.raw.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(reply.raw.headers['x-accel-buffering']).toBe('no');
    expect(reply.raw.headers['cache-control']).toBe('no-store, no-transform');
    // Las cabeceras de seguridad de siempre siguen.
    expect(reply.raw.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.raw.chunks.join('')).toContain('event: hello');
    expect(hub.size).toBe(1);
    hub.onModuleDestroy();
  });

  it('cuando cambia su saldo, le llega «cambió» (y nada del saldo)', async () => {
    const { controller, hub } = setup();
    const reply = fakeReply();
    await controller.events(WALLET.qrToken, undefined, fakeRequest() as never, reply as never);
    hub.notify(WALLET.id);
    const text = reply.raw.chunks.join('');
    expect(text).toContain('event: change');
    expect(text).not.toContain(WALLET.qrToken);
    hub.onModuleDestroy();
  });

  it('el navegador se va: la conexión se quita', async () => {
    const { controller, hub } = setup();
    const req = fakeRequest();
    await controller.events(WALLET.qrToken, undefined, req as never, fakeReply() as never);
    req.raw.emit('close');
    expect(hub.size).toBe(0);
  });

  it('con Face ID y sin su sesión: 401 WALLET_VIEW_REQUIRED (como /state), sin abrir nada', async () => {
    const { controller, hub } = setup({ passkey: true });
    const reply = fakeReply();
    const err = await controller.events(WALLET.qrToken, undefined, fakeRequest() as never, reply as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'WALLET_VIEW_REQUIRED' });
    expect(reply.hijacked).toBe(false);
    expect(hub.size).toBe(0);
  });

  it('con Face ID y su sesión: se abre, la alarga (es actividad) y se cierra cuando la sesión caduca', async () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-10-29T23:00:00Z');
    vi.setSystemTime(t0);
    const { controller, hub } = setup({ passkey: true });
    const cookie = walletViewSetCookies(SECRET, WALLET, t0)[0]!.split(';')[0]!;
    vi.setSystemTime(t0 + 5 * 60_000);
    const reply = fakeReply();
    await controller.events(WALLET.qrToken, cookie, fakeRequest() as never, reply as never);
    expect(reply.raw.statusCode).toBe(200);
    expect(reply.raw.headers['set-cookie']).toHaveLength(2);
    // Sin más actividad, a los 15 min de esta: «vuelve» (y la página, sin sesión, irá al desbloqueo).
    vi.advanceTimersByTime(WALLET_VIEW_IDLE_S * 1000 + 25_000);
    expect(reply.raw.chunks.join('')).toContain('"r":"renew"');
    expect(reply.raw.ended).toBe(true);
    expect(hub.size).toBe(0);
    hub.onModuleDestroy();
  });

  it(`sin Face ID dura como mucho ${STREAM_MAX_LIFETIME_MS / 60_000} min: luego la página vuelve a entrar (y se mira otra vez su acceso)`, async () => {
    vi.useFakeTimers();
    const { controller, hub } = setup();
    const reply = fakeReply();
    await controller.events(WALLET.qrToken, undefined, fakeRequest() as never, reply as never);
    vi.advanceTimersByTime(STREAM_MAX_LIFETIME_MS + 25_000);
    expect(reply.raw.ended).toBe(true);
    hub.onModuleDestroy();
  });

  it('un enlace que no existe: 404, sin abrir nada', async () => {
    const { controller } = setup({ missing: true });
    const reply = fakeReply();
    await expect(controller.events('otro', undefined, fakeRequest() as never, reply as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(reply.hijacked).toBe(false);
  });

  it('demasiadas desde la misma IP: 429 WALLET_EVENTS_BUSY (la página sigue con su sondeo)', async () => {
    const { controller, hub } = setup();
    vi.spyOn(hub, 'canOpen').mockReturnValue(false);
    const reply = fakeReply();
    const err = await controller.events(WALLET.qrToken, undefined, fakeRequest() as never, reply as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'WALLET_EVENTS_BUSY' });
    expect(reply.hijacked).toBe(false);
  });
});
