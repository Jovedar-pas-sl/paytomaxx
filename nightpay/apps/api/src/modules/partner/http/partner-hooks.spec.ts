import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PARTNER_BODY_LIMIT, installPartnerBodyLimit, installPartnerUrlCheck, partnerKeyInUrl } from './partner-hooks';

const KEY = `oxp_test_${'ab12'.repeat(12)}`;
const ENCODED = encodeURIComponent(KEY).replace(/_/g, '%5F');

describe('una clave en la URL', () => {
  it('se ve en la ruta y en la query, tal cual o codificada, aunque otro trozo tenga un % roto', () => {
    expect(partnerKeyInUrl(`/v1/partner/${KEY}/me`)).toBe(KEY);
    expect(partnerKeyInUrl(`/v1/partner/openapi.json?k=${KEY}`)).toBe(KEY);
    expect(partnerKeyInUrl(`/v1/partner/me?k=${ENCODED}`)).toBe(KEY);
    expect(partnerKeyInUrl(`/v1/partner/me?x=%E0%A4%A&k=${ENCODED}`)).toBe(KEY);
  });

  it('un escape roto en la misma pieza que la clave codificada no la esconde', () => {
    const hex = 'ab12'.repeat(12);
    expect(partnerKeyInUrl(`/v1/partner/me?x=%ZZoxp%5Flive%5F${hex}`)).toBe(`oxp_live_${hex}`);
    expect(partnerKeyInUrl(`/v1/partner/%E0%A4oxp%5Ftest%5F${hex}/me`)).toBe(`oxp_test_${hex}`);
  });

  it('nada que no sea una clave entera', () => {
    expect(partnerKeyInUrl('/v1/partner/me')).toBeNull();
    expect(partnerKeyInUrl(`/v1/partner/me?k=${KEY.slice(0, -1)}`)).toBeNull();
    expect(partnerKeyInUrl('/v1/partner/me?k=%ZZ')).toBeNull();
  });
});

describe('los ganchos de Fastify', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    app = null;
  });

  async function start() {
    const fastify = Fastify();
    const report = vi.fn(async (_key: string, _ip: string | null) => undefined);
    const nest = { getHttpAdapter: () => ({ getInstance: () => fastify }), get: () => ({ report }) };
    installPartnerBodyLimit(nest as never);
    installPartnerUrlCheck(nest as never);
    fastify.post('/v1/partner/prueba', async () => ({ ok: true }));
    fastify.post('/v1/otra', async () => ({ ok: true }));
    fastify.get('/v1/partner/me', async () => ({ ok: true }));
    await fastify.ready();
    app = fastify;
    return { fastify, report };
  }

  it('16 KB como mucho en /v1/partner (el resto del API sigue con el suyo)', async () => {
    const { fastify } = await start();
    const big = JSON.stringify({ x: 'a'.repeat(PARTNER_BODY_LIMIT) });
    const headers = { 'content-type': 'application/json' };
    expect((await fastify.inject({ method: 'POST', url: '/v1/partner/prueba', headers, payload: big })).statusCode).toBe(413);
    expect((await fastify.inject({ method: 'POST', url: '/v1/otra', headers, payload: big })).statusCode).toBe(200);
  });

  it('encendida: clave en la URL, 400 antes de la ruta (también si no existe) y el aviso con la IP', async () => {
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('PARTNER_API_MODE', 'test');
    const { fastify, report } = await start();
    const res = await fastify.inject({ method: 'GET', url: `/v1/partner/${KEY}/no-existe`, remoteAddress: '203.0.113.9' });
    expect(res.statusCode).toBe(400);
    expect(report).toHaveBeenCalledWith(KEY, '203.0.113.9');
    expect((await fastify.inject({ method: 'GET', url: '/v1/partner/me' })).statusCode).toBe(200);
  });

  it('apagada (o fuera de /v1/partner), el gancho no mira nada', async () => {
    const { fastify, report } = await start();
    expect((await fastify.inject({ method: 'GET', url: `/v1/partner/me?k=${KEY}` })).statusCode).toBe(200);
    vi.stubEnv('PARTNER_API_ENABLED', 'true');
    vi.stubEnv('PARTNER_API_MODE', 'test');
    expect((await fastify.inject({ method: 'GET', url: `/v1/otra?k=${KEY}` })).statusCode).toBe(404);
    expect(report).not.toHaveBeenCalled();
  });
});
