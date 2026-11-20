import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { NO_STALL_CODE, NO_STALL_MESSAGE } from '@nightpay/contracts';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { MyStallController } from './my-stall.controller';
import { StallsController } from './stalls.controller';
import { StallsService } from './stalls.service';

/**
 * Las casetas en lista por HTTP: «Abierta ahora» desde la app del personal
 * (GET/PATCH /v1/party/my-stall, solo la suya) y la zona, lo que vende y el
 * interruptor desde el panel (PATCH /v1/admin/party/stalls/:id, dueño y
 * encargado). Lo que no vale, 400; con OxioPay (EDITION=club), 404.
 */

const MINE = { id: '2d1f4c3a-9b8e-4f7a-8c6d-5e4f3a2b1c0d', name: 'Peña El Cántaro', openNow: true };
const STALL_URL = `/v1/admin/party/stalls/${MINE.id}`;
const stalls = { mine: vi.fn(), setMineOpen: vi.fn(), update: vi.fn() };

/** El AuthGuard de verdad lee el JWT; aquí, el rol de la cabecera (sin cabecera: sin sesión). */
class FakeAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();
    req.user = { sub: 'u-1', tenantId: 'venue-1', role, email: 'barra@fiesta.es' };
    return true;
  }
}

let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [MyStallController, StallsController],
    providers: [
      { provide: StallsService, useValue: stalls },
      { provide: APP_GUARD, useClass: FakeAuth },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.stubEnv('EDITION', 'party');
  stalls.mine.mockReset().mockResolvedValue(MINE);
  stalls.setMineOpen.mockReset().mockResolvedValue(MINE);
  stalls.update.mockReset().mockResolvedValue({ id: MINE.id });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const myStall = (method: 'GET' | 'PATCH', role?: string, payload?: unknown) =>
  app.inject({ method, url: '/v1/party/my-stall', headers: role ? { 'x-test-role': role } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('GET /v1/party/my-stall', () => {
  it.each(['OWNER', 'MANAGER', 'WAITER', 'OPERATOR'])('%s: su caseta (o null)', async (role) => {
    const res = await myStall('GET', role);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stall: MINE });
    expect(stalls.mine).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u-1', tenantId: 'venue-1', role }));
  });

  it('sin sesión: 401', async () => {
    expect((await myStall('GET')).statusCode).toBe(401);
  });
});

describe('PATCH /v1/party/my-stall', () => {
  it.each(['MANAGER', 'WAITER', 'OPERATOR'])('%s: abre o cierra la suya (la caseta sale de la persona)', async (role) => {
    const res = await myStall('PATCH', role, { openNow: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stall: MINE });
    expect(stalls.setMineOpen).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u-1', role }), true);
  });

  it('el dueño no tiene caseta (organiza): 403; la abre o la cierra desde el panel', async () => {
    expect((await myStall('PATCH', 'OWNER', { openNow: true })).statusCode).toBe(403);
    expect(stalls.setMineOpen).not.toHaveBeenCalled();
  });

  it('lo que no es sí o no: 400 y nada cambia; una caseta elegida en la petición no cuenta', async () => {
    for (const bad of [{}, { openNow: 'true' }, { openNow: null }]) expect((await myStall('PATCH', 'WAITER', bad)).statusCode).toBe(400);
    expect(stalls.setMineOpen).not.toHaveBeenCalled();
    await myStall('PATCH', 'WAITER', { openNow: false, stallId: 'otra' });
    expect(stalls.setMineOpen).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u-1' }), false);
  });

  it('sin caseta: el 409 NO_STALL tal cual', async () => {
    stalls.setMineOpen.mockRejectedValueOnce(new ConflictException({ code: NO_STALL_CODE, message: NO_STALL_MESSAGE }));
    const res = await myStall('PATCH', 'WAITER', { openNow: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: NO_STALL_CODE });
  });
});

describe('PATCH /v1/admin/party/stalls/:id: zona, qué vende y «Abierta ahora»', () => {
  const patch = (role: string, payload: object) => app.inject({ method: 'PATCH', url: STALL_URL, headers: { 'x-test-role': role }, payload });

  it.each(['OWNER', 'MANAGER'])('%s: se guardan sin espacios sueltos', async (role) => {
    const res = await patch(role, { zone: ' Junto al escenario ', sells: 'Bocadillos, cerveza', openNow: true });
    expect(res.statusCode).toBe(200);
    expect(stalls.update).toHaveBeenCalledWith(expect.objectContaining({ role }), MINE.id, {
      zone: 'Junto al escenario',
      sells: 'Bocadillos, cerveza',
      openNow: true,
    });
  });

  it('demasiado larga o vacía: 400 y nada cambia; el personal, 403', async () => {
    expect((await patch('OWNER', { zone: 'x'.repeat(61) })).statusCode).toBe(400);
    expect((await patch('OWNER', { sells: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await patch('OWNER', { zone: '  ' })).statusCode).toBe(400);
    expect((await patch('WAITER', { openNow: true })).statusCode).toBe(403);
    expect(stalls.update).not.toHaveBeenCalled();
  });
});

describe('con OxioPay (EDITION=club)', () => {
  it('las tres rutas dan 404 y no se hace nada', async () => {
    vi.stubEnv('EDITION', 'club');
    expect((await myStall('GET', 'WAITER')).statusCode).toBe(404);
    expect((await myStall('PATCH', 'WAITER', { openNow: true })).statusCode).toBe(404);
    const admin = await app.inject({ method: 'PATCH', url: STALL_URL, headers: { 'x-test-role': 'OWNER' }, payload: { openNow: true } });
    expect(admin.statusCode).toBe(404);
    expect(stalls.mine).not.toHaveBeenCalled();
    expect(stalls.setMineOpen).not.toHaveBeenCalled();
    expect(stalls.update).not.toHaveBeenCalled();
  });
});
