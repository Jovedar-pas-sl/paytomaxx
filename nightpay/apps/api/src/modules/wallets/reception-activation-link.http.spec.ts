import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { IpRateLimitGuard } from '../../common/guards/ip-rate-limit.guard';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { ReceptionActivationLinkController } from './reception-activation-link.controller';
import { WalletActivationLinkService, activationLinkUnavailable } from './wallet-activation-link.service';

const WALLET = '3f0c1d2e-0000-4000-8000-000000000001';
const url = (id = WALLET) => `/v1/reception/wallets/${id}/activation-link`;
const links = { link: vi.fn() };

/** El AuthGuard de verdad lee el JWT; aquí, el rol de la cabecera (sin cabecera: sin sesión). */
class FakeAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();
    req.user = { sub: 'rx-1', tenantId: 'venue-1', role };
    return true;
  }
}

let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [ReceptionActivationLinkController],
    providers: [
      { provide: WalletActivationLinkService, useValue: links },
      { provide: REDIS_CLIENT, useValue: createFakeRedis() },
      { provide: APP_GUARD, useClass: FakeAuth },
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => {
  links.link.mockReset().mockResolvedValue({ url: ACTIVATION_URL, expiresAt: '2026-10-27T01:13:00.000Z' });
});

/** El QR de activación de un solo uso (M-2): /w/a/<token>, nunca el enlace del saldo. */
const ACTIVATION_URL = 'https://api.paytomaxx.com/w/a/Ab3_kQ9-zXw2LmN8pR4tVy6uHs1oJe5c';

describe('POST /v1/reception/wallets/:id/activation-link (emite uno nuevo; el GET de antes, igual)', () => {
  it.each(['WAITER', 'MANAGER', 'OWNER'])('%s: 200 con { url, expiresAt }, sin caché ni Referer', async (role) => {
    const res = await app.inject({ method: 'POST', url: url(), headers: { 'x-test-role': role, 'x-forwarded-for': `10.0.0.${role.length}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: ACTIVATION_URL, expiresAt: '2026-10-27T01:13:00.000Z' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(links.link).toHaveBeenCalledWith({ userId: 'rx-1', role, tenantId: 'venue-1' }, WALLET, expect.any(Date), {});
  });

  it('la ficha que recepción acaba de leer llega al servicio; una que no es nuestra, 400', async () => {
    const card = 'Ab3_kQ9-zXw2LmN8pR4t';
    const res = await app.inject({ method: 'POST', url: url(), headers: { 'x-test-role': 'WAITER', 'x-forwarded-for': '10.0.2.1' }, payload: { card, uid: '04:AA' } });
    expect(res.statusCode).toBe(200);
    expect(links.link).toHaveBeenCalledWith({ userId: 'rx-1', role: 'WAITER', tenantId: 'venue-1' }, WALLET, expect.any(Date), { card, uid: '04:AA' });
    links.link.mockClear();
    const bad = await app.inject({ method: 'POST', url: url(), headers: { 'x-test-role': 'WAITER', 'x-forwarded-for': '10.0.2.2' }, payload: { card: 'no vale' } });
    expect(bad.statusCode).toBe(400);
    expect(links.link).not.toHaveBeenCalled();
  });

  it('el GET de antes (apps del personal aún sin actualizar) hace lo mismo', async () => {
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-test-role': 'WAITER', 'x-forwarded-for': '10.0.1.1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: ACTIVATION_URL, expiresAt: '2026-10-27T01:13:00.000Z' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(links.link).toHaveBeenCalledWith({ userId: 'rx-1', role: 'WAITER', tenantId: 'venue-1' }, WALLET, expect.any(Date), {});
  });

  it('las chicas (OPERATOR) y el super-admin no llegan al servicio; sin sesión, 401', async () => {
    for (const role of ['OPERATOR', 'SUPERADMIN']) {
      for (const method of ['POST', 'GET'] as const) {
        expect((await app.inject({ method, url: url(), headers: { 'x-test-role': role } })).statusCode).toBe(403);
      }
    }
    expect((await app.inject({ method: 'POST', url: url() })).statusCode).toBe(401);
    expect(links.link).not.toHaveBeenCalled();
  });

  it('un id que no es un UUID: 400 sin llegar al servicio', async () => {
    expect((await app.inject({ method: 'POST', url: url('no-es-un-uuid'), headers: { 'x-test-role': 'OWNER' } })).statusCode).toBe(400);
    expect(links.link).not.toHaveBeenCalled();
  });

  it('el 404 lleva el code y el motivo para la pantalla de recepción', async () => {
    links.link.mockRejectedValue(activationLinkUnavailable('FACE_ID_SET'));
    const res = await app.inject({ method: 'POST', url: url(), headers: { 'x-test-role': 'WAITER' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ACTIVATION_LINK_UNAVAILABLE', reason: 'FACE_ID_SET' });
  });

  it('límite por IP: 30 por minuto (POST y GET juntos) y después 429', async () => {
    const headers = { 'x-test-role': 'WAITER', 'x-forwarded-for': '10.9.9.9' };
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await app.inject({ method: i % 2 ? 'GET' : 'POST', url: url(), headers })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});
