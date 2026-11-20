import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CartaController } from './carta.controller';
import { CartaService } from './carta.service';

const ID = '00000000-0000-4000-8000-000000000001';
const service = { setSoldOut: vi.fn().mockResolvedValue({ id: ID, soldOut: true }) };
let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({ controllers: [CartaController], providers: [{ provide: CartaService, useValue: service }] })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();
        const role = request.headers['x-test-role'];
        if (!role) throw new UnauthorizedException();
        request.user = { sub: 'actor-1', tenantId: 'tenant-1', role };
        return true;
      },
    })
    .compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { service.setSoldOut.mockClear(); });

const put = (role: string | null, payload: object) =>
  app.inject({ method: 'PUT', url: `/v1/services/${ID}/sold-out`, headers: role ? { 'x-test-role': role } : {}, payload });

describe('PUT /v1/services/:id/sold-out', () => {
  it.each(['OWNER', 'MANAGER', 'WAITER', 'OPERATOR'])('lo permite a %s, siempre con SU local', async (role) => {
    const res = await put(role, { soldOut: true });
    expect(res.statusCode).toBe(200);
    expect(service.setSoldOut).toHaveBeenCalledWith('tenant-1', 'actor-1', ID, true);
  });
  it('un rol que no es del personal de la carta, no', async () => {
    const res = await put('RECEPTION', { soldOut: true });
    expect(res.statusCode).toBe(403);
    expect(service.setSoldOut).not.toHaveBeenCalled();
  });
  it.each([{}, { soldOut: 'si' }])('rechaza un cuerpo raro', async (payload) => {
    expect((await put('WAITER', payload)).statusCode).toBe(400);
    expect(service.setSoldOut).not.toHaveBeenCalled();
  });
  it('pide sesión', async () => {
    expect((await put(null, { soldOut: true })).statusCode).toBe(401);
  });
});
