import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CartaController } from './carta.controller';
import { CartaService } from './carta.service';

const service = { applyTemplate: vi.fn().mockResolvedValue({ created: 13, updated: 0, kept: 0 }) };
let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [CartaController], providers: [{ provide: CartaService, useValue: service }],
  }).overrideGuard(AuthGuard).useValue({
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest();
      const role = request.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      request.user = { sub: 'actor-1', tenantId: 'tenant-1', role };
      return true;
    },
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { service.applyTemplate.mockClear(); });

describe('POST /v1/services/template', () => {
  it.each(['OWNER', 'MANAGER'])('permits %s with explicit confirmation', async (role) => {
    const res = await app.inject({ method: 'POST', url: '/v1/services/template', headers: { 'x-test-role': role }, payload: { confirm: true } });
    expect(res.statusCode).toBe(201);
    expect(service.applyTemplate).toHaveBeenCalledWith('tenant-1', 'actor-1', { confirm: true });
  });
  it.each(['WAITER', 'OPERATOR', 'RECEPTION'])('forbids %s', async (role) => {
    const res = await app.inject({ method: 'POST', url: '/v1/services/template', headers: { 'x-test-role': role }, payload: { confirm: true } });
    expect(res.statusCode).toBe(403);
    expect(service.applyTemplate).not.toHaveBeenCalled();
  });
  it.each([{}, { confirm: false }, { confirm: true, items: [] }])('rejects absent confirmation and custom products', async (payload) => {
    const res = await app.inject({ method: 'POST', url: '/v1/services/template', headers: { 'x-test-role': 'OWNER' }, payload });
    expect(res.statusCode).toBe(400);
    expect(service.applyTemplate).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/services/template', payload: { confirm: true } });
    expect(res.statusCode).toBe(401);
  });
});
