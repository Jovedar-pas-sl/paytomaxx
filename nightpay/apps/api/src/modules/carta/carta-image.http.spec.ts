import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { isGlobalRateLimitExempt } from '../../common/http/global-rate-limit';
import { CartaController, CartaImageController } from './carta.controller';
import { CartaService } from './carta.service';
import { webpFixture } from '../../../test/support/webp-fixture';

const ID = '0b0e5d3e-6a56-4a3e-9d2f-0d6a8c0c9a11';
const HASH = 'a'.repeat(64);
const bytes = webpFixture();
const service = {
  imageFor: vi.fn(),
  setImage: vi.fn().mockResolvedValue({ id: ID, imageUrl: `/v1/services/${ID}/image/${HASH}` }),
  removeImage: vi.fn().mockResolvedValue({ id: ID, imageUrl: null }),
};
let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [CartaController, CartaImageController],
    providers: [{ provide: CartaService, useValue: service }],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        // Como el AuthGuard de verdad: @Public() deja pasar sin sesión.
        if (new Reflector().getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
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
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  service.imageFor.mockReset();
  service.setImage.mockClear();
  service.removeImage.mockClear();
});

describe('GET /v1/services/:id/image/:hash', () => {
  it('sirve el WebP sin sesión, con caché de un año, nosniff y el tipo bien', async () => {
    service.imageFor.mockResolvedValue({ data: bytes, contentHash: HASH });
    const res = await app.inject({ method: 'GET', url: `/v1/services/${ID}/image/${HASH}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers.etag).toBe(`"${HASH}"`);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(service.imageFor).toHaveBeenCalledWith(ID, HASH);
  });

  it('huella que no es de la imagen actual, o de otro producto: 404 y sin cabeceras de caché', async () => {
    service.imageFor.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: `/v1/services/${ID}/image/${HASH}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
  });

  it.each(['abc', 'A'.repeat(64), `${'a'.repeat(63)}g`])('huella mal formada (%s): 404 sin ir a la base', async (hash) => {
    const res = await app.inject({ method: 'GET', url: `/v1/services/${ID}/image/${hash}` });
    expect(res.statusCode).toBe(404);
    expect(service.imageFor).not.toHaveBeenCalled();
  });

  it('el id tiene que ser un UUID', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/services/nope/image/${HASH}` });
    expect(res.statusCode).toBe(400);
  });

  it('tiene su propio freno por IP y el límite global la deja fuera', () => {
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, CartaImageController.prototype.image)).toMatchObject({ scope: 'carta-image', failOpen: true });
    expect(isGlobalRateLimitExempt({ method: 'GET', url: `/v1/services/${ID}/image/${HASH}` } as never)).toBe(true);
    expect(isGlobalRateLimitExempt({ method: 'GET', url: '/v1/services/all' } as never)).toBe(false);
    expect(isGlobalRateLimitExempt({ method: 'PUT', url: `/v1/services/${ID}/image` } as never)).toBe(false);
  });
});

describe('PUT/DELETE /v1/services/:id/image', () => {
  const payload = { data: bytes.toString('base64') };
  it.each(['OWNER', 'MANAGER'])('%s sube y quita', async (role) => {
    const up = await app.inject({ method: 'PUT', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': role }, payload });
    expect(up.statusCode).toBe(200);
    expect(service.setImage).toHaveBeenCalledWith('tenant-1', 'actor-1', ID, payload.data);
    const del = await app.inject({ method: 'DELETE', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': role } });
    expect(del.statusCode).toBe(200);
    expect(service.removeImage).toHaveBeenCalledWith('tenant-1', 'actor-1', ID);
  });

  it.each(['WAITER', 'OPERATOR', 'RECEPTION'])('%s no puede (403)', async (role) => {
    const up = await app.inject({ method: 'PUT', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': role }, payload });
    const del = await app.inject({ method: 'DELETE', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': role } });
    expect([up.statusCode, del.statusCode]).toEqual([403, 403]);
    expect(service.setImage).not.toHaveBeenCalled();
  });

  it('sin sesión: 401', async () => {
    expect((await app.inject({ method: 'PUT', url: `/v1/services/${ID}/image`, payload })).statusCode).toBe(401);
  });

  it('un cuerpo de más de 64 KB o que no es base64 se corta antes del servicio', async () => {
    const big = Buffer.alloc(64 * 1024 + 1024, 1).toString('base64');
    const a = await app.inject({ method: 'PUT', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': 'OWNER' }, payload: { data: big } });
    const b = await app.inject({ method: 'PUT', url: `/v1/services/${ID}/image`, headers: { 'x-test-role': 'OWNER' }, payload: { data: '<svg onload=alert(1)>' } });
    expect([a.statusCode, b.statusCode]).toEqual([400, 400]);
    expect(service.setImage).not.toHaveBeenCalled();
  });

  it('la subida tiene su freno por IP', () => {
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, CartaController.prototype.setImage)).toMatchObject({ scope: 'carta-image-upload', max: 60 });
  });
});
