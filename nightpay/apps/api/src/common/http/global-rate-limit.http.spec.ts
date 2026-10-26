import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { JwtService } from '@nestjs/jwt';
import { GLOBAL_LIMITS, createGlobalRateLimit } from './global-rate-limit';

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

describe('límite global con los topes de verdad: la prueba real de punta a punta (FSD-01)', () => {
  it('Paula manda 6.100 en un minuto (600 pasan, 5.500 se quedan en 429) y Carlos, Sergio y Camarero 01 siguen trabajando', async () => {
    const [paula, carlos, sergio, camarero01] = [
      '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
      '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
      '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
    ];
    const { call } = await server({ ...GLOBAL_LIMITS });
    const paulaToken = token(paula!);
    const counts: Record<number, number> = {};
    for (let i = 0; i < 6_100; i++) {
      const { statusCode } = await call(paulaToken, '/v1/x');
      counts[statusCode] = (counts[statusCode] ?? 0) + 1;
    }
    expect(counts).toEqual({ 200: 600, 429: 5_500 });
    for (const who of [carlos, sergio, camarero01]) expect((await call(token(who!))).statusCode).toBe(200);
  }, 120_000);
});
