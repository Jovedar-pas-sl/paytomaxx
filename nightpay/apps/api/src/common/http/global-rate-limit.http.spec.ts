import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { JwtService } from '@nestjs/jwt';
import { createGlobalRateLimit } from './global-rate-limit';

/**
 * El límite global con el plugin de verdad (@fastify/rate-limit, como en
 * main.ts) y topes pequeños: el mismo wifi para todos.
 */

const SECRET = 'secreto-de-las-pruebas-0123456789abcdef0123';
const VENUE = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const LOCAL_IP = '81.0.0.7';
const jwt = new JwtService({ secret: SECRET });
const users = ['9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'];
const token = (sub: string) =>
  jwt.sign({ sub, email: 'x@local.es', role: 'WAITER', tenantId: VENUE, venueSlug: 'sala' }, { expiresIn: 3600 });

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function server(limits: { ip: number; user: number; venue: number }) {
  app = Fastify();
  const rl = createGlobalRateLimit({ jwtSecret: SECRET, limits });
  await app.register(rateLimit, {
    timeWindow: 60_000,
    max: rl.max,
    keyGenerator: rl.keyGenerator,
    allowList: rl.allowList,
    onExceeded: rl.onExceeded,
  });
  app.get('/v1/x', async () => ({ ok: true }));
  app.get('/v1/payments/public/:token', async () => ({ status: 'CREATED' }));
  await app.ready();
  const call = async (bearer?: string, url = '/v1/x') => {
    const res = await app!.inject({
      method: 'GET',
      url,
      remoteAddress: LOCAL_IP,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    return res;
  };
  return { call };
}

async function statuses(n: number, fn: () => Promise<{ statusCode: number }>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fn()).statusCode);
  return out;
}

describe('límite global con el plugin (SEC-02)', () => {
  it('con los anónimos del wifi agotados, el personal sigue trabajando (cada uno con su cupo)', async () => {
    const { call } = await server({ ip: 3, user: 4, venue: 100 });
    expect(await statuses(4, () => call())).toEqual([200, 200, 200, 429]);
    expect(await statuses(5, () => call(token(users[0]!)))).toEqual([200, 200, 200, 200, 429]);
    expect(await statuses(1, () => call(token(users[1]!)))).toEqual([200]);
  });

  it('un token inventado no se libra del límite de los anónimos', async () => {
    const { call } = await server({ ip: 2, user: 50, venue: 100 });
    const fake = jwt.sign({ sub: users[0], tenantId: VENUE }, { secret: 'otro-secreto-cualquiera-000000000000000' });
    expect(await statuses(3, () => call(fake))).toEqual([200, 200, 429]);
  });

  it('el local entero tiene su tope: 429 con Retry-After, también para quien no había gastado el suyo', async () => {
    const { call } = await server({ ip: 3, user: 50, venue: 5 });
    expect(await statuses(3, () => call(token(users[0]!)))).toEqual([200, 200, 200]);
    expect(await statuses(2, () => call(token(users[1]!)))).toEqual([200, 200]);
    const res = await call(token(users[2]!));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('una persona con la app en bucle se queda en su 429; el resto del local sigue', async () => {
    const { call } = await server({ ip: 3, user: 4, venue: 10 });
    const looping = await statuses(40, () => call(token(users[0]!)));
    expect(looping.filter((s) => s === 200)).toHaveLength(4);
    expect(await statuses(4, () => call(token(users[1]!)))).toEqual([200, 200, 200, 200]);
    expect(await statuses(2, () => call(token(users[2]!)))).toEqual([200, 200]);
    expect((await call(token(users[2]!))).statusCode).toBe(429);
  });

  it('el sondeo público del cobro no gasta el cupo de los anónimos', async () => {
    const { call } = await server({ ip: 2, user: 50, venue: 100 });
    expect(await statuses(6, () => call(undefined, '/v1/payments/public/qr-1'))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await statuses(3, () => call())).toEqual([200, 200, 429]);
  });
});
